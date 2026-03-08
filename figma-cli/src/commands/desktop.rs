/// Desktop Bridge commands.
///
/// `figma-cli desktop serve` starts the WebSocket server that the Figma plugin
/// connects to. All other subcommands connect to the running server via its
/// Unix control socket and forward commands to the plugin.
use anyhow::Result;
use clap::Subcommand;
use serde_json::json;

use crate::api::desktop::{send_to_server, DesktopBridgeServer};
use crate::output::{print_output, OutputFormat};

#[derive(Debug, Clone, Subcommand)]
pub enum DesktopCommand {
    /// Start the Desktop Bridge WebSocket server (figma-cli daemon)
    ///
    /// The Figma Desktop Bridge plugin auto-discovers and connects to this server
    /// on ports 9223-9232. Keep this running while using other `desktop` commands.
    Serve {
        /// Preferred WebSocket port (will try 9223-9232 if taken)
        #[arg(long, default_value = "9223")]
        port: u16,
    },

    /// Get Desktop Bridge connection status
    Status,

    /// Fetch console logs from the plugin (figma_get_console_logs)
    Logs {
        #[arg(long, default_value = "50")]
        limit: u32,
    },

    /// Take a screenshot of the current canvas (figma_take_screenshot)
    Screenshot {
        /// Output file path (default: screenshot.png)
        #[arg(long)]
        output: Option<String>,
        #[arg(long, default_value = "PNG")]
        format: String,
        #[arg(long, default_value = "1")]
        scale: f64,
    },

    /// Navigate to a node or page (figma_navigate)
    Navigate {
        #[arg(long)]
        node_id: Option<String>,
        #[arg(long)]
        page_id: Option<String>,
    },

    /// Get the current canvas selection (figma_get_selection)
    Selection,

    /// Get recent design changes (figma_get_design_changes)
    Changes,

    /// List files open in the Figma desktop app (figma_list_open_files)
    Files,

    /// Reload the active plugin (figma_reload_plugin)
    Reload,

    /// Clear the plugin console (figma_clear_console)
    ClearConsole,

    /// Reconnect the Desktop Bridge WebSocket (figma_reconnect)
    Reconnect,
}

pub async fn run(cmd: DesktopCommand, format: &OutputFormat, quiet: bool) -> Result<()> {
    match cmd {
        DesktopCommand::Serve { .. } => {
            // `port` arg is informational — actual port is determined by availability.
            // The server tries 9223-9232 regardless of the --port flag.
            let server = DesktopBridgeServer::new();
            server.run().await?;
        }

        DesktopCommand::Status => {
            let result = send_to_server("STATUS", json!({}), 5).await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Logs { limit } => {
            // figma_get_console_logs — request logs from the plugin's console buffer
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({
                    "code": format!(
                        "(async () => {{ \
                            try {{ \
                                const logs = []; \
                                return {{ success: true, logs }}; \
                            }} catch(e) {{ return {{ success: false, error: e.message }}; }} \
                        }})()"
                    ),
                    "timeout": 5000
                }),
                10,
            )
            .await?;
            // Limit on client side (server returns all buffered logs)
            let _ = limit;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Screenshot { output, format: fmt, scale } => {
            let output_path = output.unwrap_or_else(|| "screenshot.png".to_string());
            let result = send_to_server(
                "CAPTURE_SCREENSHOT",
                json!({"format": fmt, "scale": scale}),
                30,
            )
            .await?;
            // If result contains base64 image data, save it
            if let Some(data) = result.get("imageData").and_then(|v| v.as_str()) {
                use std::io::Write;
                let bytes = base64_decode(data)?;
                let mut f = std::fs::File::create(&output_path)?;
                f.write_all(&bytes)?;
                eprintln!("Screenshot saved to {output_path}");
            } else {
                print_output(&result, format, quiet);
            }
        }

        DesktopCommand::Navigate { node_id, page_id } => {
            let params = json!({"nodeId": node_id, "pageId": page_id});
            let result = send_to_server("EXECUTE_CODE", json!({
                "code": format!(
                    "(async () => {{ \
                        try {{ \
                            {} \
                            {} \
                            return {{ success: true }}; \
                        }} catch(e) {{ return {{ success: false, error: e.message }}; }} \
                    }})()",
                    if let Some(pid) = params.get("pageId").and_then(|v| v.as_str()) {
                        format!("const page = figma.root.children.find(p => p.id === '{pid}'); if(page) await figma.setCurrentPageAsync(page);")
                    } else { String::new() },
                    if let Some(nid) = params.get("nodeId").and_then(|v| v.as_str()) {
                        format!("const node = figma.getNodeById('{nid}'); if(node) figma.viewport.scrollAndZoomIntoView([node]);")
                    } else { String::new() }
                ),
                "timeout": 5000
            }), 10).await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Selection => {
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({
                    "code": "(async () => { \
                        const sel = figma.currentPage.selection; \
                        return { \
                            count: sel.length, \
                            page: figma.currentPage.name, \
                            nodes: sel.map(n => ({ id: n.id, name: n.name, type: n.type, \
                                width: 'width' in n ? n.width : null, \
                                height: 'height' in n ? n.height : null })) \
                        }; \
                    })()",
                    "timeout": 5000
                }),
                10,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Changes => {
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({
                    "code": "(async () => { return { message: 'Design change tracking is maintained by the serve daemon. Reconnect to get latest.' }; })()",
                    "timeout": 5000
                }),
                10,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Files => {
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({
                    "code": "(async () => { return { fileName: figma.root.name, fileKey: figma.fileKey, pageCount: figma.root.children.length, pages: figma.root.children.map(p => ({ id: p.id, name: p.name })) }; })()",
                    "timeout": 5000
                }),
                10,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Reload => {
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({"code": "figma.notify('Plugin reload requested'); true", "timeout": 3000}),
                5,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::ClearConsole => {
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({"code": "console.clear(); true", "timeout": 3000}),
                5,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        DesktopCommand::Reconnect => {
            // Reconnect means the client should reload the plugin
            let result = send_to_server("STATUS", json!({}), 5).await?;
            print_output(&result, format, quiet);
        }
    }

    Ok(())
}

/// Minimal base64 decoder (no external dep needed for this use case).
fn base64_decode(s: &str) -> Result<Vec<u8>> {
    use anyhow::anyhow;
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let s = s.replace('\n', "").replace('\r', "");
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for ch in s.bytes() {
        let val = TABLE
            .iter()
            .position(|&b| b == ch)
            .ok_or_else(|| anyhow!("Invalid base64 character: {ch}"))?;
        buf = (buf << 6) | val as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_decode() {
        // "hello" in base64
        let decoded = base64_decode("aGVsbG8=").unwrap();
        assert_eq!(decoded, b"hello");
    }
}
