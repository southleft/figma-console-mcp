/// Variable management commands.
///
/// Maps to the Figma Variables REST API (Enterprise plan required).
/// Mutation commands (create, update, delete, etc.) use the POST
/// `/files/{key}/variables` endpoint with typed payloads.
use anyhow::Result;
use clap::Subcommand;
use serde_json::json;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_output, print_warning};

#[derive(Debug, Subcommand)]
pub enum VariablesCommand {
    /// List all variables in a file (figma_get_variables)
    List {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },

    /// Create a variable (figma_create_variable)
    Create {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        collection_id: String,
        #[arg(long)]
        name: String,
        /// Variable type: BOOLEAN | STRING | FLOAT | COLOR
        #[arg(long, default_value = "STRING")]
        variable_type: String,
    },

    /// Update a variable's value (figma_update_variable)
    Update {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        variable_id: String,
        #[arg(long)]
        mode_id: String,
        #[arg(long)]
        value: String,
    },

    /// Delete a variable (figma_delete_variable)
    Delete {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        variable_id: String,
    },

    /// Rename a variable (figma_rename_variable)
    Rename {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        variable_id: String,
        #[arg(long)]
        new_name: String,
    },

    /// Create a variable collection (figma_create_variable_collection)
    CreateCollection {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        name: String,
    },

    /// Delete a variable collection (figma_delete_variable_collection)
    DeleteCollection {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        collection_id: String,
    },

    /// Add a mode to a collection (figma_add_mode)
    AddMode {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        collection_id: String,
        #[arg(long)]
        name: String,
    },

    /// Rename a mode (figma_rename_mode)
    RenameMode {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        collection_id: String,
        #[arg(long)]
        mode_id: String,
        #[arg(long)]
        new_name: String,
    },

    /// Batch-create variables from a JSON file (figma_batch_create_variables)
    BatchCreate {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Path to JSON file containing array of variable definitions
        #[arg(long)]
        json_file: String,
    },

    /// Batch-update variable values from a JSON file (figma_batch_update_variables)
    BatchUpdate {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Path to JSON file containing array of variable updates
        #[arg(long)]
        json_file: String,
    },

    /// Setup design tokens from a token JSON file (figma_setup_design_tokens)
    SetupTokens {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Path to design tokens JSON file
        #[arg(long)]
        tokens_file: String,
    },

    /// Browse tokens interactively (figma_browse_tokens)
    Browse {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Filter by collection name
        #[arg(long)]
        collection: Option<String>,
    },
}

pub async fn run(
    cmd: VariablesCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        VariablesCommand::List { file } => {
            let key = parse_file_key(&file);
            let result = api.get_variables(&key).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::Create {
            file,
            collection_id,
            name,
            variable_type,
        } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": [{
                    "action": "CREATE",
                    "id": format!("temp:{name}"),
                    "name": name,
                    "variableCollectionId": collection_id,
                    "resolvedType": variable_type,
                }],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::Update {
            file,
            variable_id,
            mode_id,
            value,
        } => {
            let key = parse_file_key(&file);
            // Attempt to parse value as JSON, fall back to string
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or(serde_json::Value::String(value));
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": [],
                "variableModeValues": [{
                    "action": "UPDATE",
                    "variableId": variable_id,
                    "modeId": mode_id,
                    "value": parsed_value,
                }]
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::Delete { file, variable_id } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": [{
                    "action": "DELETE",
                    "id": variable_id,
                }],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::Rename {
            file,
            variable_id,
            new_name,
        } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": [{
                    "action": "UPDATE",
                    "id": variable_id,
                    "name": new_name,
                }],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::CreateCollection { file, name } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [{
                    "action": "CREATE",
                    "id": format!("temp:{name}"),
                    "name": name,
                }],
                "variableModes": [],
                "variables": [],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::DeleteCollection {
            file,
            collection_id,
        } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [{
                    "action": "DELETE",
                    "id": collection_id,
                }],
                "variableModes": [],
                "variables": [],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::AddMode {
            file,
            collection_id,
            name,
        } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [],
                "variableModes": [{
                    "action": "CREATE",
                    "id": format!("temp:{name}"),
                    "name": name,
                    "variableCollectionId": collection_id,
                }],
                "variables": [],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::RenameMode {
            file,
            collection_id: _,
            mode_id,
            new_name,
        } => {
            let key = parse_file_key(&file);
            let payload = json!({
                "variableCollections": [],
                "variableModes": [{
                    "action": "UPDATE",
                    "id": mode_id,
                    "name": new_name,
                }],
                "variables": [],
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::BatchCreate { file, json_file } => {
            let key = parse_file_key(&file);
            let content = std::fs::read_to_string(&json_file)
                .map_err(|e| anyhow::anyhow!("failed to read {json_file}: {e}"))?;
            let variables: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| anyhow::anyhow!("invalid JSON in {json_file}: {e}"))?;
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": variables,
                "variableModeValues": []
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::BatchUpdate { file, json_file } => {
            let key = parse_file_key(&file);
            let content = std::fs::read_to_string(&json_file)
                .map_err(|e| anyhow::anyhow!("failed to read {json_file}: {e}"))?;
            let mode_values: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| anyhow::anyhow!("invalid JSON in {json_file}: {e}"))?;
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": [],
                "variableModeValues": mode_values,
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::SetupTokens { file, tokens_file } => {
            let key = parse_file_key(&file);
            let content = std::fs::read_to_string(&tokens_file)
                .map_err(|e| anyhow::anyhow!("failed to read {tokens_file}: {e}"))?;
            let tokens: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| anyhow::anyhow!("invalid JSON in {tokens_file}: {e}"))?;
            // NOTE: A production implementation would transform W3C design tokens
            // into Figma variable payloads. For now we surface the raw token tree.
            print_warning("setup-tokens: sending token tree directly — full W3C token transformation not yet implemented");
            let payload = json!({
                "variableCollections": [],
                "variableModes": [],
                "variables": [],
                "variableModeValues": [],
                "_tokens": tokens,
            });
            let result = api.post_variables(&key, &payload).await?;
            print_output(&result, format, quiet);
        }

        VariablesCommand::Browse { file, collection } => {
            let key = parse_file_key(&file);
            let result = api.get_variables(&key).await?;

            // Filter by collection name if requested
            if let Some(col) = collection {
                if let Some(meta) = result.get("meta") {
                    if let Some(collections) = meta.get("variableCollections") {
                        let filtered: Vec<_> = collections
                            .as_object()
                            .map(|m| {
                                m.values()
                                    .filter(|v| {
                                        v.get("name")
                                            .and_then(|n| n.as_str())
                                            .map(|n| n.contains(&col))
                                            .unwrap_or(false)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let filtered_json = serde_json::to_value(filtered)?;
                        print_output(&filtered_json, format, quiet);
                        return Ok(());
                    }
                }
            }

            print_output(&result, format, quiet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn test_value_parse_fallback_to_string() {
        let raw = "hello";
        let parsed: serde_json::Value =
            serde_json::from_str(raw).unwrap_or(serde_json::Value::String(raw.to_string()));
        assert_eq!(parsed, json!("hello"));
    }

    #[test]
    fn test_value_parse_number() {
        let raw = "42";
        let parsed: serde_json::Value =
            serde_json::from_str(raw).unwrap_or(serde_json::Value::String(raw.to_string()));
        assert_eq!(parsed, json!(42));
    }

    #[test]
    fn test_value_parse_bool() {
        let raw = "true";
        let parsed: serde_json::Value =
            serde_json::from_str(raw).unwrap_or(serde_json::Value::String(raw.to_string()));
        assert_eq!(parsed, json!(true));
    }
}
