/// Desktop Bridge WebSocket client stub.
///
/// The Desktop Bridge requires the Figma desktop app with the companion plugin
/// running. This module provides the client type and a placeholder that
/// describes how to connect.
use anyhow::Result;
use serde_json::Value;

/// WebSocket client for the Figma Desktop Bridge.
///
/// The Desktop Bridge plugin exposes a WebSocket server on a configurable
/// local port. This client would normally send JSON-RPC style messages and
/// receive plugin execution results.
#[derive(Debug)]
pub struct DesktopBridgeClient {
    /// WebSocket URL, e.g. `ws://localhost:9000/ws`
    pub ws_url: String,
}

impl DesktopBridgeClient {
    /// Create a new desktop bridge client targeting the given port.
    pub fn new(port: u16) -> Self {
        Self {
            ws_url: format!("ws://localhost:{port}/ws"),
        }
    }

    /// Send a command to the plugin and await its response.
    ///
    /// Currently returns a stub error — wire up a WebSocket library (e.g.
    /// `tokio-tungstenite`) to implement the full protocol.
    pub async fn send_command(&self, command: &str, params: Option<Value>) -> Result<Value> {
        let _ = (command, params);
        anyhow::bail!(
            "Desktop Bridge not yet connected. \
             Start the Figma Desktop Bridge plugin and connect at {}",
            self.ws_url
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_desktop_bridge_url_format() {
        let client = DesktopBridgeClient::new(9000);
        assert_eq!(client.ws_url, "ws://localhost:9000/ws");
    }

    #[test]
    fn test_desktop_bridge_custom_port() {
        let client = DesktopBridgeClient::new(12345);
        assert!(client.ws_url.contains("12345"));
    }

    #[tokio::test]
    async fn test_send_command_returns_error() {
        let client = DesktopBridgeClient::new(9000);
        let result = client.send_command("figma_get_status", None).await;
        assert!(result.is_err());
    }
}
