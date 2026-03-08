/// Commands for file and data retrieval.
use anyhow::Result;
use clap::Subcommand;
use serde_json::json;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_output};

#[derive(Debug, Subcommand)]
pub enum FileCommand {
    /// Fetch file data (figma_get_file_data)
    GetData {
        /// File URL or key
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,

        /// Max depth of node tree to return
        #[arg(long)]
        depth: Option<u32>,

        /// Comma-separated node IDs to include
        #[arg(long)]
        nodes: Option<String>,
    },

    /// Get styles defined in a file (figma_get_styles)
    GetStyles {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },

    /// Fetch design system kit metadata (figma_get_design_system_kit)
    GetKit {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },

    /// Get file data in plugin-compatible format (figma_get_file_for_plugin)
    ForPlugin {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },
}

pub async fn run(
    cmd: FileCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        FileCommand::GetData { file, depth, nodes } => {
            let key = parse_file_key(&file);
            let node_ids: Option<Vec<String>> = nodes
                .map(|s| s.split(',').map(|n| n.trim().to_string()).collect());
            let result = api
                .get_file(&key, depth, node_ids.as_deref())
                .await?;
            print_output(&result, format, quiet);
        }

        FileCommand::GetStyles { file } => {
            let key = parse_file_key(&file);
            let result = api.get_styles(&key).await?;
            print_output(&result, format, quiet);
        }

        FileCommand::GetKit { file } => {
            let key = parse_file_key(&file);
            // Kit: components + component sets + styles
            let components = api.get_components(&key).await?;
            let styles = api.get_styles(&key).await?;
            let kit = json!({
                "components": components,
                "styles": styles,
            });
            print_output(&kit, format, quiet);
        }

        FileCommand::ForPlugin { file } => {
            let key = parse_file_key(&file);
            let result = api.get_file_for_plugin(&key).await?;
            print_output(&result, format, quiet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::api::client::parse_file_key;

    #[test]
    fn test_nodes_split() {
        let input = "0:1, 0:2, 0:3";
        let ids: Vec<String> = input.split(',').map(|n| n.trim().to_string()).collect();
        assert_eq!(ids, vec!["0:1", "0:2", "0:3"]);
    }

    #[test]
    fn test_file_key_from_env_like_url() {
        let url = "https://www.figma.com/design/TESTKEY123/project-name";
        assert_eq!(parse_file_key(url), "TESTKEY123");
    }
}
