/// Execute JavaScript in the plugin context via the Desktop Bridge.
///
/// Maps to `figma_execute` in the MCP server. Requires `figma-cli desktop serve`
/// to be running with the Figma Desktop Bridge plugin connected.
use anyhow::Result;
use clap::Subcommand;
use serde_json::json;

use crate::api::desktop::send_to_server;
use crate::output::{print_output, OutputFormat};

#[derive(Debug, Clone, Subcommand)]
pub enum ExecuteCommand {
    /// Execute JavaScript in the plugin context (figma_execute)
    Run {
        /// JavaScript expression or block to evaluate in the plugin context
        #[arg(long)]
        code: String,
        /// Timeout in milliseconds
        #[arg(long, default_value = "5000")]
        timeout_ms: u64,
    },
}

pub async fn run(cmd: ExecuteCommand, format: &OutputFormat, quiet: bool) -> Result<()> {
    match cmd {
        ExecuteCommand::Run { code, timeout_ms } => {
            let result = send_to_server(
                "EXECUTE_CODE",
                json!({"code": code, "timeout": timeout_ms}),
                (timeout_ms / 1000) + 5, // seconds, with buffer
            )
            .await?;
            print_output(&result, format, quiet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_execute_module_compiles() {
        // Compilation check
    }
}
