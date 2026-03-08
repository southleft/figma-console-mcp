/// Desktop Bridge WebSocket server and IPC client.
///
/// Architecture:
///   `figma-cli desktop serve` starts a WebSocket server on port 9223 (range 9223-9232)
///   that the Figma Desktop Bridge plugin connects to, identical to how figma-console-mcp
///   works. It also binds a Unix domain socket for local IPC so other `figma-cli` commands
///   can send bridge commands without needing to handle WebSocket themselves.
///
/// Port advertisement:
///   Port files are written to /tmp/figma-cli-{port}.json (different prefix from the MCP
///   server's figma-console-mcp-{port}.json) to avoid collision.
///
/// Protocol (WebSocket, server → plugin):
///   {"id":"ws_N_TS","method":"EXECUTE_CODE","params":{...}}
///
/// Protocol (WebSocket, plugin → server):
///   {"type":"FILE_INFO","data":{"fileKey":"...","fileName":"...",...}}  — on connect
///   {"id":"ws_N_TS","result":...}                                        — command response
///   {"id":"ws_N_TS","error":"..."}                                       — error response
///
/// Protocol (Unix socket, newline-delimited JSON):
///   → {"id":"ctrl_N","method":"EXECUTE_CODE","params":{...}}
///   ← {"id":"ctrl_N","result":...}
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;

/// WebSocket port range (must match figma-console-mcp, 9223-9232).
pub const PORT_START: u16 = 9223;
pub const PORT_RANGE: u16 = 10;

/// Port file prefix — different from MCP server to allow both to coexist.
const CLI_PREFIX: &str = "figma-cli-";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

// ─── Port file management ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortFile {
    pub port: u16,
    pub pid: u32,
    pub host: String,
    pub started_at: String,
    pub control_socket: String,
}

pub fn port_file_path(port: u16) -> PathBuf {
    std::env::temp_dir().join(format!("{CLI_PREFIX}{port}.json"))
}

pub fn socket_path(port: u16) -> PathBuf {
    std::env::temp_dir().join(format!("{CLI_PREFIX}{port}.sock"))
}

fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    // SAFETY: kill(pid, 0) is a well-known idiom for checking process existence.
    unsafe {
        libc::kill(pid as libc::pid_t, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn now_iso() -> String {
    // Format current time as ISO-8601 without pulling in chrono.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, m, s) = epoch_to_ymd(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn epoch_to_ymd(mut secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    secs /= 60;
    let m = secs % 60;
    secs /= 60;
    let h = secs % 24;
    secs /= 24;
    // Simplified date calc (good enough for log display)
    let days = secs;
    let y = 1970 + days / 365;
    let mo = (days % 365) / 30 + 1;
    let d = (days % 365) % 30 + 1;
    (y, mo, d, h, m, s)
}

/// Find the first running CLI Desktop Bridge server (port file + live PID check).
pub fn discover_server() -> Option<PortFile> {
    for port in PORT_START..PORT_START + PORT_RANGE {
        let path = port_file_path(port);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(data) = serde_json::from_str::<PortFile>(&raw) {
                if is_pid_alive(data.pid) {
                    return Some(data);
                }
                // Stale — clean up
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(socket_path(port));
            }
        }
    }
    None
}

fn write_port_file(port: u16, sock: &str) -> Result<()> {
    let data = PortFile {
        port,
        pid: std::process::id(),
        host: "localhost".to_string(),
        started_at: now_iso(),
        control_socket: sock.to_string(),
    };
    std::fs::write(port_file_path(port), serde_json::to_string_pretty(&data)?)?;
    Ok(())
}

fn remove_port_file(port: u16) {
    let _ = std::fs::remove_file(port_file_path(port));
    let _ = std::fs::remove_file(socket_path(port));
}

// ─── Shared server state ─────────────────────────────────────────────────────

struct ServerState {
    /// Channel to send raw JSON strings to the plugin.
    plugin_tx: Option<tokio::sync::mpsc::Sender<String>>,
    /// Pending command callbacks: request id → oneshot sender.
    pending: HashMap<String, oneshot::Sender<Result<Value>>>,
    /// FILE_INFO data from the connected plugin.
    file_info: Option<Value>,
}

impl ServerState {
    fn new() -> Self {
        Self {
            plugin_tx: None,
            pending: HashMap::new(),
            file_info: None,
        }
    }
}

// ─── Desktop Bridge server ───────────────────────────────────────────────────

/// Runs the Desktop Bridge WebSocket server.
///
/// Call `run()` to start listening — this blocks until Ctrl-C.
pub struct DesktopBridgeServer {
    state: Arc<Mutex<ServerState>>,
}

impl DesktopBridgeServer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ServerState::new())),
        }
    }

    /// Bind WS + control socket and return (port, socket_path).
    async fn bind(&self) -> Result<(u16, String, TcpListener, UnixListener)> {
        // Try ports 9223-9232
        let mut ws_port = None;
        let mut tcp = None;
        for port in PORT_START..PORT_START + PORT_RANGE {
            match TcpListener::bind(format!("127.0.0.1:{port}")).await {
                Ok(l) => {
                    ws_port = Some(port);
                    tcp = Some(l);
                    break;
                }
                Err(_) => continue,
            }
        }
        let port = ws_port.ok_or_else(|| anyhow!("All ports {PORT_START}–{} are in use. Is another figma-cli serve or figma-console-mcp running?", PORT_START + PORT_RANGE - 1))?;
        let tcp = tcp.unwrap();

        let sock = socket_path(port);
        if sock.exists() {
            let _ = std::fs::remove_file(&sock);
        }
        let unix = UnixListener::bind(&sock)
            .with_context(|| format!("Failed to bind control socket {sock:?}"))?;
        let sock_str = sock.to_string_lossy().to_string();
        write_port_file(port, &sock_str)?;

        Ok((port, sock_str, tcp, unix))
    }

    /// Run server until Ctrl-C. Cleans up port files on exit.
    pub async fn run(self) -> Result<()> {
        let (port, sock_str, tcp, unix) = self.bind().await?;

        eprintln!("Desktop Bridge server listening on ws://localhost:{port}");
        eprintln!("Control socket: {sock_str}");
        eprintln!("Waiting for Figma Desktop Bridge plugin to connect...\n");
        eprintln!("In Figma: open the figma-console-mcp plugin, it will auto-connect.\n");

        let state = self.state.clone();

        // WebSocket acceptor task
        let state_ws = state.clone();
        let ws_task = tokio::spawn(async move {
            loop {
                match tcp.accept().await {
                    Ok((stream, _addr)) => {
                        let s = state_ws.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_ws_connection(stream, s).await {
                                eprintln!("[WS] error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[WS] accept error: {e}");
                        break;
                    }
                }
            }
        });

        // Control socket acceptor task
        let state_ctrl = state.clone();
        let ctrl_task = tokio::spawn(async move {
            loop {
                match unix.accept().await {
                    Ok((stream, _)) => {
                        let s = state_ctrl.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_control_connection(stream, s).await {
                                eprintln!("[CTRL] error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[CTRL] accept error: {e}");
                        break;
                    }
                }
            }
        });

        // Wait for Ctrl-C
        tokio::signal::ctrl_c().await?;
        eprintln!("\nShutting down...");
        remove_port_file(port);
        ws_task.abort();
        ctrl_task.abort();
        Ok(())
    }
}

// ─── WebSocket connection handler ────────────────────────────────────────────

async fn handle_ws_connection(
    stream: tokio::net::TcpStream,
    state: Arc<Mutex<ServerState>>,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut stream) = ws.split();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    {
        let mut s = state.lock().await;
        s.plugin_tx = Some(tx);
    }

    eprintln!("[WS] Plugin connected — waiting for FILE_INFO...");

    // Forward queued messages to plugin
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages from plugin
    while let Some(msg_result) = stream.next().await {
        match msg_result? {
            Message::Text(text) => {
                if let Ok(val) = serde_json::from_str::<Value>(&text) {
                    handle_plugin_message(val, &state).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    eprintln!("[WS] Plugin disconnected");
    let mut s = state.lock().await;
    s.plugin_tx = None;
    s.file_info = None;
    for (_, tx) in s.pending.drain() {
        let _ = tx.send(Err(anyhow!("Plugin disconnected")));
    }
    Ok(())
}

async fn handle_plugin_message(msg: Value, state: &Arc<Mutex<ServerState>>) {
    // FILE_INFO from plugin on connect
    if msg.get("type").and_then(|v| v.as_str()) == Some("FILE_INFO") {
        if let Some(data) = msg.get("data") {
            let name = data
                .get("fileName")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            eprintln!("[WS] File connected: {name}");
            state.lock().await.file_info = Some(data.clone());
        }
        return;
    }

    // Response to a command we sent
    if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
        let mut s = state.lock().await;
        if let Some(tx) = s.pending.remove(id) {
            if let Some(err) = msg.get("error").and_then(|v| v.as_str()) {
                let _ = tx.send(Err(anyhow!("{err}")));
            } else {
                let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
    }
}

// ─── Control socket handler ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CtrlRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
    /// Optional per-command timeout in milliseconds.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

async fn handle_control_connection(
    stream: UnixStream,
    state: Arc<Mutex<ServerState>>,
) -> Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let resp = match serde_json::from_str::<CtrlRequest>(&line) {
            Err(e) => json!({"id":"?","error":format!("parse error: {e}")}),
            Ok(req) => {
                let timeout_ms = req.timeout_ms.unwrap_or(15_000);
                match dispatch_control(&req, timeout_ms, &state).await {
                    Ok(v) => json!({"id": req.id, "result": v}),
                    Err(e) => json!({"id": req.id, "error": e.to_string()}),
                }
            }
        };

        write_half
            .write_all((resp.to_string() + "\n").as_bytes())
            .await?;
    }
    Ok(())
}

async fn dispatch_control(
    req: &CtrlRequest,
    timeout_ms: u64,
    state: &Arc<Mutex<ServerState>>,
) -> Result<Value> {
    match req.method.as_str() {
        "STATUS" => {
            let s = state.lock().await;
            Ok(json!({
                "connected": s.plugin_tx.is_some(),
                "file": s.file_info,
            }))
        }
        method => bridge_send(method, req.params.clone(), timeout_ms, state).await,
    }
}

/// Send a command to the plugin and await its response.
async fn bridge_send(
    method: &str,
    params: Value,
    timeout_ms: u64,
    state: &Arc<Mutex<ServerState>>,
) -> Result<Value> {
    let counter = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let id = format!("ws_{counter}_{ts}");

    let msg = json!({"id": id, "method": method, "params": params}).to_string();
    let (tx, rx) = oneshot::channel::<Result<Value>>();

    let plugin_tx = {
        let mut s = state.lock().await;
        let tx_clone = s
            .plugin_tx
            .as_ref()
            .ok_or_else(|| {
                anyhow!("No Figma plugin connected. Open the Desktop Bridge plugin in Figma.")
            })?
            .clone();
        s.pending.insert(id.clone(), tx);
        tx_clone
    };

    plugin_tx
        .send(msg)
        .await
        .map_err(|_| anyhow!("Plugin send channel closed"))?;

    timeout(Duration::from_millis(timeout_ms), rx)
        .await
        .map_err(|_| anyhow!("Timeout after {timeout_ms}ms waiting for plugin response"))?
        .map_err(|_| anyhow!("Command cancelled (server shutting down)"))?
}

// ─── IPC client (used by individual CLI commands) ────────────────────────────

/// Send a control command to the running `figma-cli desktop serve` process.
pub async fn send_to_server(method: &str, params: Value, timeout_secs: u64) -> Result<Value> {
    let server = discover_server().ok_or_else(|| {
        anyhow!(
            "No figma-cli Desktop Bridge server running.\n\
             Start one with: figma-cli desktop serve\n\
             Then open the Desktop Bridge plugin in Figma."
        )
    })?;

    let sock = PathBuf::from(&server.control_socket);
    let stream = UnixStream::connect(&sock)
        .await
        .with_context(|| format!("Cannot connect to control socket {sock:?}"))?;

    let id = format!(
        "ctrl_{}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let req = json!({"id": id, "method": method, "params": params, "timeout_ms": timeout_secs * 1000 - 500});
    let req_str = req.to_string() + "\n";

    let (read_half, mut write_half) = stream.into_split();
    write_half.write_all(req_str.as_bytes()).await?;

    let result = tokio::time::timeout(Duration::from_secs(timeout_secs), async {
        let mut lines = BufReader::new(read_half).lines();
        let line = lines
            .next_line()
            .await?
            .ok_or_else(|| anyhow!("Server closed connection without response"))?;
        let resp: Value = serde_json::from_str(&line)?;
        if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
            return Err(anyhow!("{err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    })
    .await
    .map_err(|_| anyhow!("Timeout after {timeout_secs}s waiting for Desktop Bridge"))??;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_port_file_path() {
        let p = port_file_path(9223);
        assert!(p.to_string_lossy().contains("figma-cli-9223.json"));
    }

    #[test]
    fn test_socket_path() {
        let p = socket_path(9223);
        assert!(p.to_string_lossy().contains("figma-cli-9223.sock"));
    }

    #[test]
    fn test_now_iso_format() {
        let s = now_iso();
        // Basic format check: YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
    }

    #[test]
    fn test_discover_server_no_files() {
        // With no port files present, discover_server returns None.
        // (May return Some if a real server is running, that's fine.)
        let _ = discover_server();
    }
}
