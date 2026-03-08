/// CLI argument definitions using clap derive macros.
use clap::{Parser, Subcommand};

use crate::commands::{
    comments::CommentsCommand,
    components::ComponentsCommand,
    design_system::DesignSystemCommand,
    desktop::DesktopCommand,
    execute::ExecuteCommand,
    file::FileCommand,
    nodes::NodesCommand,
    styles::StylesCommand,
    variables::VariablesCommand,
};
use crate::output::OutputFormat;

/// figma-cli — command-line interface for the Figma API.
///
/// Wraps all figma-console-mcp tools as composable shell commands.
/// Set FIGMA_ACCESS_TOKEN and FIGMA_FILE_URL in your environment or .env file.
#[derive(Debug, Parser)]
#[command(
    name = "figma",
    version,
    author,
    about = "CLI analog of the figma-console-mcp MCP server",
    long_about = None,
)]
pub struct Cli {
    /// Figma personal access token (overrides FIGMA_ACCESS_TOKEN env var)
    #[arg(long, env = "FIGMA_ACCESS_TOKEN", global = true, hide_env_values = true)]
    pub token: Option<String>,

    /// Output format
    #[arg(long, global = true, default_value = "pretty")]
    pub output: OutputFormat,

    /// Suppress decorations — print raw JSON only
    #[arg(long, global = true, default_value = "false")]
    pub quiet: bool,

    /// Print request timing and debug info
    #[arg(long, global = true, default_value = "false")]
    pub verbose: bool,

    #[command(subcommand)]
    pub command: Command,
}

/// Top-level subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// File and data retrieval
    File {
        #[command(subcommand)]
        cmd: FileCommand,
    },

    /// Variable management (requires Figma Enterprise plan)
    Variables {
        #[command(subcommand)]
        cmd: VariablesCommand,
    },

    /// Component operations
    Components {
        #[command(subcommand)]
        cmd: ComponentsCommand,
    },

    /// Style operations
    Styles {
        #[command(subcommand)]
        cmd: StylesCommand,
    },

    /// Comment management
    Comments {
        #[command(subcommand)]
        cmd: CommentsCommand,
    },

    /// Design system inspection
    DesignSystem {
        #[command(subcommand)]
        cmd: DesignSystemCommand,
    },

    /// Node manipulation (Desktop Bridge required for mutations)
    Nodes {
        #[command(subcommand)]
        cmd: NodesCommand,
    },

    /// Desktop Bridge operations (requires Figma desktop app + plugin)
    Desktop {
        #[command(subcommand)]
        cmd: DesktopCommand,
    },

    /// Execute JavaScript in the plugin context (Desktop Bridge required)
    Execute {
        #[command(subcommand)]
        cmd: ExecuteCommand,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn test_cli_parses_help() {
        // verify --help doesn't panic
        Cli::command().debug_assert();
    }
}
