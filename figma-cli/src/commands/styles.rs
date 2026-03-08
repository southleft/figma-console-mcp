/// Style-related sub-commands (currently delegated through the file command).
///
/// Figma's REST API exposes styles via the file endpoint, so this module
/// provides a thin adapter that re-uses `FigmaApi::get_styles`.
use anyhow::Result;
use clap::Subcommand;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_output};

#[derive(Debug, Subcommand)]
pub enum StylesCommand {
    /// List all styles in a file
    List {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
    },
}

pub async fn run(
    cmd: StylesCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        StylesCommand::List { file } => {
            let key = parse_file_key(&file);
            let result = api.get_styles(&key).await?;
            print_output(&result, format, quiet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_styles_module_exists() {
        // Compilation check — commands are tested via integration
    }
}
