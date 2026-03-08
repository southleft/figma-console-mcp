/// Node manipulation commands.
///
/// Read-only `get` uses the REST API. All mutation commands (resize, move,
/// fills, etc.) use the Desktop Bridge via `figma-cli desktop serve`.
use anyhow::Result;
use clap::Subcommand;
use serde_json::json;

use crate::api::{client::parse_file_key, desktop::send_to_server, figma::FigmaApi};
use crate::output::{print_output, OutputFormat};

#[derive(Debug, Subcommand)]
pub enum NodesCommand {
    /// Resize a node (figma_resize_node) — requires Desktop Bridge
    Resize {
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        width: f64,
        #[arg(long)]
        height: f64,
        #[arg(long, default_value = "true")]
        with_constraints: bool,
    },

    /// Move a node (figma_move_node) — requires Desktop Bridge
    Move {
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        x: f64,
        #[arg(long)]
        y: f64,
    },

    /// Set fills on a node (figma_set_fills) — requires Desktop Bridge
    SetFills {
        #[arg(long)]
        node_id: String,
        /// JSON array of fill paint objects
        #[arg(long)]
        fills_json: String,
    },

    /// Set strokes on a node (figma_set_strokes) — requires Desktop Bridge
    SetStrokes {
        #[arg(long)]
        node_id: String,
        /// JSON array of stroke paint objects
        #[arg(long)]
        strokes_json: String,
        #[arg(long)]
        stroke_weight: Option<f64>,
    },

    /// Clone a node (figma_clone_node) — requires Desktop Bridge
    Clone {
        #[arg(long)]
        node_id: String,
    },

    /// Delete a node (figma_delete_node) — requires Desktop Bridge
    Delete {
        #[arg(long)]
        node_id: String,
    },

    /// Rename a node (figma_rename_node) — requires Desktop Bridge
    Rename {
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        new_name: String,
    },

    /// Set text content on a text node (figma_set_text) — requires Desktop Bridge
    SetText {
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        text: String,
        #[arg(long)]
        font_size: Option<f64>,
    },

    /// Create a child node (figma_create_child) — requires Desktop Bridge
    CreateChild {
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
        // ── REST API (no Desktop Bridge needed) ──────────────────────────────
        NodesCommand::Get { file, ids, depth } => {
            let key = parse_file_key(&file);
            let node_ids: Vec<String> = ids.split(',').map(|s| s.trim().to_string()).collect();
            let result = api.get_nodes(&key, &node_ids, depth).await?;
            print_output(&result, format, quiet);
        }

        // ── Desktop Bridge mutations ─────────────────────────────────────────
        NodesCommand::Resize { node_id, width, height, with_constraints } => {
            let result = send_to_server(
                "RESIZE_NODE",
                json!({"nodeId": node_id, "width": width, "height": height, "withConstraints": with_constraints}),
                15,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::Move { node_id, x, y } => {
            let result =
                send_to_server("MOVE_NODE", json!({"nodeId": node_id, "x": x, "y": y}), 15)
                    .await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::SetFills { node_id, fills_json } => {
            let fills: serde_json::Value = serde_json::from_str(&fills_json)
                .map_err(|e| anyhow::anyhow!("Invalid fills JSON: {e}"))?;
            let result =
                send_to_server("SET_NODE_FILLS", json!({"nodeId": node_id, "fills": fills}), 15)
                    .await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::SetStrokes { node_id, strokes_json, stroke_weight } => {
            let strokes: serde_json::Value = serde_json::from_str(&strokes_json)
                .map_err(|e| anyhow::anyhow!("Invalid strokes JSON: {e}"))?;
            let mut params = json!({"nodeId": node_id, "strokes": strokes});
            if let Some(w) = stroke_weight {
                params["strokeWeight"] = json!(w);
            }
            let result = send_to_server("SET_NODE_STROKES", params, 15).await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::Clone { node_id } => {
            let result =
                send_to_server("CLONE_NODE", json!({"nodeId": node_id}), 15).await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::Delete { node_id } => {
            let result =
                send_to_server("DELETE_NODE", json!({"nodeId": node_id}), 15).await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::Rename { node_id, new_name } => {
            let result = send_to_server(
                "RENAME_NODE",
                json!({"nodeId": node_id, "newName": new_name}),
                15,
            )
            .await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::SetText { node_id, text, font_size } => {
            let mut params = json!({"nodeId": node_id, "text": text});
            if let Some(fs) = font_size {
                params["fontSize"] = json!(fs);
            }
            let result = send_to_server("SET_TEXT_CONTENT", params, 15).await?;
            print_output(&result, format, quiet);
        }

        NodesCommand::CreateChild { parent_id, node_type, name } => {
            let props = if let Some(n) = name {
                json!({"name": n})
            } else {
                json!({})
            };
            let result = send_to_server(
                "CREATE_CHILD_NODE",
                json!({"parentId": parent_id, "nodeType": node_type, "properties": props}),
                15,
            )
            .await?;
            print_output(&result, format, quiet);
        }
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
