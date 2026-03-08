/// Component management commands.
use anyhow::Result;
use clap::Subcommand;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_output};

#[derive(Debug, Subcommand)]
pub enum ComponentsCommand {
    /// Get a component by its key (figma_get_component)
    Get {
        /// Component key (not the node ID — the component's published key)
        #[arg(long)]
        key: String,
    },

    /// Get a rendered image of a component (figma_get_component_image)
    GetImage {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
        #[arg(long, default_value = "1")]
        scale: f64,
        /// Output image format: png | jpg | svg | pdf
        #[arg(long, default_value = "png")]
        format: String,
    },

    /// Get component with developer metadata (figma_get_component_for_development)
    ForDev {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
    },

    /// Search components by name (figma_search_components)
    Search {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Search query
        #[arg(long)]
        query: String,
    },

    /// Get detailed component information (figma_get_component_details)
    Details {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
    },

    /// Instantiate a component (figma_instantiate_component)
    Instantiate {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        component_key: String,
    },

    /// Set the description on a component (figma_set_description)
    SetDescription {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        description: String,
    },

    /// Add a property to a component (figma_add_component_property)
    AddProperty {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        name: String,
        /// Property type: BOOLEAN | TEXT | INSTANCE_SWAP | VARIANT
        #[arg(long)]
        property_type: String,
        #[arg(long)]
        default_value: Option<String>,
    },

    /// Edit an existing component property (figma_edit_component_property)
    EditProperty {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        property_name: String,
        #[arg(long)]
        new_name: Option<String>,
        #[arg(long)]
        default_value: Option<String>,
    },

    /// Delete a component property (figma_delete_component_property)
    DeleteProperty {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        property_name: String,
    },

    /// Arrange items in a component set (figma_arrange_component_set)
    ArrangeSet {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        component_set_id: String,
    },

    /// Generate documentation for a component (figma_generate_component_doc)
    GenerateDoc {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
    },

    /// Check design/code parity for a component (figma_check_design_parity)
    CheckParity {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        node_id: String,
    },
}

pub async fn run(
    cmd: ComponentsCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        ComponentsCommand::Get { key } => {
            let result = api.get_component(&key).await?;
            print_output(&result, format, quiet);
        }

        ComponentsCommand::GetImage {
            file,
            node_id,
            scale,
            format: img_format,
        } => {
            let key = parse_file_key(&file);
            let result = api
                .get_images(&key, &[node_id], Some(scale), Some(&img_format))
                .await?;
            print_output(&result, format, quiet);
        }

        ComponentsCommand::ForDev { file, node_id } => {
            let key = parse_file_key(&file);
            let result = api.get_nodes(&key, &[node_id], Some(5)).await?;
            print_output(&result, format, quiet);
        }

        ComponentsCommand::Search { file, query } => {
            let key = parse_file_key(&file);
            let result = api.get_components(&key).await?;
            let filtered = filter_by_name(&result, &query);
            print_output(&filtered, format, quiet);
        }

        ComponentsCommand::Details { file, node_id } => {
            let key = parse_file_key(&file);
            let result = api.get_nodes(&key, &[node_id], None).await?;
            print_output(&result, format, quiet);
        }

        // Commands below require Desktop Bridge plugin access
        ComponentsCommand::Instantiate { .. } => {
            crate::output::print_desktop_stub(9000);
        }

        ComponentsCommand::SetDescription { .. } => {
            crate::output::print_desktop_stub(9000);
        }

        ComponentsCommand::AddProperty { .. } => {
            crate::output::print_desktop_stub(9000);
        }

        ComponentsCommand::EditProperty { .. } => {
            crate::output::print_desktop_stub(9000);
        }

        ComponentsCommand::DeleteProperty { .. } => {
            crate::output::print_desktop_stub(9000);
        }

        ComponentsCommand::ArrangeSet { .. } => {
            crate::output::print_desktop_stub(9000);
        }

        ComponentsCommand::GenerateDoc { file, node_id } => {
            let key = parse_file_key(&file);
            let result = api.get_nodes(&key, &[node_id], Some(3)).await?;
            print_output(&result, format, quiet);
        }

        ComponentsCommand::CheckParity { file, node_id } => {
            let key = parse_file_key(&file);
            let result = api.get_nodes(&key, &[node_id], Some(2)).await?;
            print_output(&result, format, quiet);
        }
    }
    Ok(())
}

/// Filter a components API response by name substring (case-insensitive).
fn filter_by_name(result: &serde_json::Value, query: &str) -> serde_json::Value {
    let query_lower = query.to_lowercase();

    if let Some(meta) = result.get("meta") {
        if let Some(components) = meta.get("components") {
            if let Some(arr) = components.as_array() {
                let filtered: Vec<_> = arr
                    .iter()
                    .filter(|c| {
                        c.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| n.to_lowercase().contains(&query_lower))
                            .unwrap_or(false)
                    })
                    .collect();
                return serde_json::to_value(filtered).unwrap_or(serde_json::Value::Null);
            }
        }
    }

    result.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_filter_by_name_matches() {
        let data = json!({
            "meta": {
                "components": [
                    {"name": "Button Primary", "key": "abc"},
                    {"name": "Input Field", "key": "def"},
                    {"name": "Button Secondary", "key": "ghi"},
                ]
            }
        });
        let filtered = filter_by_name(&data, "button");
        let arr = filtered.as_array().unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn test_filter_by_name_case_insensitive() {
        let data = json!({
            "meta": {
                "components": [
                    {"name": "MODAL", "key": "abc"},
                ]
            }
        });
        let filtered = filter_by_name(&data, "modal");
        assert_eq!(filtered.as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_filter_by_name_no_match() {
        let data = json!({
            "meta": {
                "components": [
                    {"name": "Card", "key": "abc"},
                ]
            }
        });
        let filtered = filter_by_name(&data, "nonexistent");
        assert_eq!(filtered.as_array().unwrap().len(), 0);
    }
}
