/// Execute JavaScript in a plugin context via the Desktop Bridge.
///
/// This command maps to `figma_execute` in the MCP server and requires the
/// Desktop Bridge plugin to be connected. It is provided here as a stub that
/// explains what is needed.
use anyhow::Result;
use clap::Subcommand;

use crate::output::print_desktop_stub;

#[derive(Debug, Clone, Subcommand)]
pub enum ExecuteCommand {
    /// Execute JavaScript in the plugin context (figma_execute)
    Run {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        /// JavaScript expression or block to evaluate in the plugin context
        #[arg(long)]
        code: String,
        /// Timeout in milliseconds
        #[arg(long, default_value = "5000")]
        timeout_ms: u64,
    },
}

pub async fn run(cmd: ExecuteCommand) -> Result<()> {
    match cmd {
        ExecuteCommand::Run { port, code: _, timeout_ms: _ } => {
            print_desktop_stub(port);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_execute_module_compiles() {
        // Compilation check — command is a stub
    }
}
