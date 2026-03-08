/// Node manipulation commands (via Desktop Bridge).
///
/// All node mutation commands (resize, move, fills, etc.) require the Figma
/// Desktop Bridge plugin. Read-only node fetching is done via the REST API.
use anyhow::Result;
use clap::Subcommand;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_desktop_stub, print_output};

#[derive(Debug, Subcommand)]
pub enum NodesCommand {
    /// Resize a node (figma_resize_node) — requires Desktop Bridge
    Resize {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        width: f64,
        #[arg(long)]
        height: f64,
    },

    /// Move a node (figma_move_node) — requires Desktop Bridge
    Move {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        x: f64,
        #[arg(long)]
        y: f64,
    },

    /// Set fills on a node (figma_set_fills) — requires Desktop Bridge
    SetFills {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
        /// JSON array of fill paint objects
        #[arg(long)]
        fills_json: String,
    },

    /// Set strokes on a node (figma_set_strokes) — requires Desktop Bridge
    SetStrokes {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
        /// JSON array of stroke paint objects
        #[arg(long)]
        strokes_json: String,
    },

    /// Clone a node (figma_clone_node) — requires Desktop Bridge
    Clone {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
    },

    /// Delete a node (figma_delete_node) — requires Desktop Bridge
    Delete {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
    },

    /// Rename a node (figma_rename_node) — requires Desktop Bridge
    Rename {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        new_name: String,
    },

    /// Set text content on a text node (figma_set_text) — requires Desktop Bridge
    SetText {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        text: String,
    },

    /// Create a child node (figma_create_child) — requires Desktop Bridge
    CreateChild {
        #[arg(long, env = "FIGMA_WS_PORT", default_value = "9000")]
        port: u16,
        #[arg(long)]
        parent_id: String,
        /// Node type: FRAME | RECTANGLE | TEXT | ELLIPSE
        #[arg(long, default_value = "FRAME")]
        node_type: String,
        #[arg(long)]
        name: Option<String>,
    },

    /// Fetch node data from a file (REST API — no Desktop Bridge needed)
    Get {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Node IDs (comma-separated)
        #[arg(long)]
        ids: String,
        #[arg(long)]
        depth: Option<u32>,
    },
}

pub async fn run(
    cmd: NodesCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        // REST API command — no Desktop Bridge needed
        NodesCommand::Get { file, ids, depth } => {
            let key = parse_file_key(&file);
            let node_ids: Vec<String> =
                ids.split(',').map(|s| s.trim().to_string()).collect();
            let result = api.get_nodes(&key, &node_ids, depth).await?;
            print_output(&result, format, quiet);
        }

        // All mutation commands require Desktop Bridge
        NodesCommand::Resize { port, .. } => print_desktop_stub(port),
        NodesCommand::Move { port, .. } => print_desktop_stub(port),
        NodesCommand::SetFills { port, .. } => print_desktop_stub(port),
        NodesCommand::SetStrokes { port, .. } => print_desktop_stub(port),
        NodesCommand::Clone { port, .. } => print_desktop_stub(port),
        NodesCommand::Delete { port, .. } => print_desktop_stub(port),
        NodesCommand::Rename { port, .. } => print_desktop_stub(port),
        NodesCommand::SetText { port, .. } => print_desktop_stub(port),
        NodesCommand::CreateChild { port, .. } => print_desktop_stub(port),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_id_split() {
        let ids = "0:1, 0:2, 3:4";
        let parsed: Vec<String> = ids.split(',').map(|s| s.trim().to_string()).collect();
        assert_eq!(parsed, vec!["0:1", "0:2", "3:4"]);
    }
}
