/// Design system inspection commands.
///
/// These commands summarize and audit a Figma file's design system by
/// combining data from the styles, components, and variables endpoints.
use anyhow::Result;
use clap::Subcommand;
use serde_json::json;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_output};

#[derive(Debug, Subcommand)]
pub enum DesignSystemCommand {
    /// Print a high-level summary of the design system (figma_get_design_system_summary)
    Summary {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },

    /// List resolved token values (figma_get_token_values)
    Tokens {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Filter by collection name
        #[arg(long)]
        collection: Option<String>,
    },

    /// Audit the design system for consistency issues (figma_audit_design_system)
    Audit {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },
}

pub async fn run(
    cmd: DesignSystemCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        DesignSystemCommand::Summary { file } => {
            let key = parse_file_key(&file);

            // Gather data concurrently
            let (components, styles, variables) = tokio::join!(
                api.get_components(&key),
                api.get_styles(&key),
                api.get_variables(&key),
            );

            let component_count = components
                .as_ref()
                .ok()
                .and_then(|v| v.get("meta"))
                .and_then(|m| m.get("components"))
                .and_then(|c| c.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            let style_count = styles
                .as_ref()
                .ok()
                .and_then(|v| v.get("meta"))
                .and_then(|m| m.get("styles"))
                .and_then(|s| s.as_array())
                .map(|a| a.len())
                .unwrap_or(0);

            let variable_count = variables
                .as_ref()
                .ok()
                .and_then(|v| v.get("meta"))
                .and_then(|m| m.get("variables"))
                .and_then(|vs| vs.as_object())
                .map(|o| o.len())
                .unwrap_or(0);

            let collection_count = variables
                .as_ref()
                .ok()
                .and_then(|v| v.get("meta"))
                .and_then(|m| m.get("variableCollections"))
                .and_then(|c| c.as_object())
                .map(|o| o.len())
                .unwrap_or(0);

            let summary = json!({
                "file_key": key,
                "components": component_count,
                "styles": style_count,
                "variables": variable_count,
                "variable_collections": collection_count,
            });

            print_output(&summary, format, quiet);
        }

        DesignSystemCommand::Tokens { file, collection } => {
            let key = parse_file_key(&file);
            let result = api.get_variables(&key).await?;

            if let Some(col) = collection {
                // Filter to a specific collection
                if let Some(meta) = result.get("meta") {
                    if let Some(collections) = meta.get("variableCollections") {
                        if let Some(obj) = collections.as_object() {
                            let matched: Vec<_> = obj
                                .values()
                                .filter(|v| {
                                    v.get("name")
                                        .and_then(|n| n.as_str())
                                        .map(|n| n.contains(&col))
                                        .unwrap_or(false)
                                })
                                .collect();
                            let out = serde_json::to_value(matched)?;
                            print_output(&out, format, quiet);
                            return Ok(());
                        }
                    }
                }
            }

            print_output(&result, format, quiet);
        }

        DesignSystemCommand::Audit { file } => {
            let key = parse_file_key(&file);

            let (components, styles) = tokio::join!(
                api.get_components(&key),
                api.get_styles(&key),
            );

            let mut issues: Vec<serde_json::Value> = Vec::new();

            // Check for components missing descriptions
            if let Ok(comps) = &components {
                if let Some(arr) = comps
                    .get("meta")
                    .and_then(|m| m.get("components"))
                    .and_then(|c| c.as_array())
                {
                    for comp in arr {
                        let name = comp.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let desc = comp
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("");
                        if desc.is_empty() {
                            issues.push(json!({
                                "type": "missing_description",
                                "kind": "component",
                                "name": name,
                            }));
                        }
                    }
                }
            }

            // Check for styles missing descriptions
            if let Ok(styl) = &styles {
                if let Some(arr) = styl
                    .get("meta")
                    .and_then(|m| m.get("styles"))
                    .and_then(|s| s.as_array())
                {
                    for style in arr {
                        let name = style.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let desc = style
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("");
                        if desc.is_empty() {
                            issues.push(json!({
                                "type": "missing_description",
                                "kind": "style",
                                "name": name,
                            }));
                        }
                    }
                }
            }

            let audit = json!({
                "issues_found": issues.len(),
                "issues": issues,
            });

            print_output(&audit, format, quiet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_design_system_module_compiles() {
        // Compilation check
    }
}
