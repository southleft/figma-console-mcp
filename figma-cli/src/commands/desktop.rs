/// Desktop Bridge command stubs.
///
/// All commands in this module require the Figma Desktop Bridge plugin to be
/// running in the Figma desktop app. Each command prints a helpful connection
/// message rather than silently failing.
use anyhow::Result;
use clap::Subcommand;

use crate::output::print_desktop_stub;

#[derive(Debug, Clone, Subcommand)]
pub enum DesktopCommand {
    /// Get Desktop Bridge connection status (figma_get_status)
    Status {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },

    /// Fetch console logs from the plugin (figma_get_console_logs)
    Logs {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long, default_value = "50")]
        limit: u32,
    },

    /// Take a screenshot of the current canvas (figma_take_screenshot)
    Screenshot {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        /// Output file path (default: screenshot.png)
        #[arg(long)]
        output: Option<String>,
    },

    /// Navigate to a node or page (figma_navigate)
    Navigate {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: Option<String>,
        #[arg(long)]
        page_id: Option<String>,
    },

    /// Reload the active plugin (figma_reload_plugin)
    Reload {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },

    /// Clear the plugin console (figma_clear_console)
    ClearConsole {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },

    /// Reconnect the Desktop Bridge WebSocket (figma_reconnect)
    Reconnect {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },

    /// Get the current canvas selection (figma_get_selection)
    Selection {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },

    /// Get recent design changes (figma_get_design_changes)
    Changes {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },

    /// List files open in the Figma desktop app (figma_list_open_files)
    Files {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
    },
}

pub async fn run(cmd: DesktopCommand) -> Result<()> {
    let port = match &cmd {
        DesktopCommand::Status { port } => *port,
        DesktopCommand::Logs { port, .. } => *port,
        DesktopCommand::Screenshot { port, .. } => *port,
        DesktopCommand::Navigate { port, .. } => *port,
        DesktopCommand::Reload { port } => *port,
        DesktopCommand::ClearConsole { port } => *port,
        DesktopCommand::Reconnect { port } => *port,
        DesktopCommand::Selection { port } => *port,
        DesktopCommand::Changes { port } => *port,
        DesktopCommand::Files { port } => *port,
    };

    print_desktop_stub(port);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_desktop_module_compiles() {
        // Compilation check — all commands are stubs
    }
}
