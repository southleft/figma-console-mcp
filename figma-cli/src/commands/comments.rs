/// Commands for reading and writing file comments.
use anyhow::Result;
use clap::Subcommand;

use crate::api::{client::parse_file_key, figma::FigmaApi};
use crate::output::{OutputFormat, print_output};

#[derive(Debug, Subcommand)]
pub enum CommentsCommand {
    /// List comments on a file (figma_get_comments)
    List {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        /// Include resolved comments
        #[arg(long, default_value = "false")]
        include_resolved: bool,
    },

    /// Post a comment on a file (figma_post_comment)
    Post {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        message: String,
        /// Target node ID (optional — pins comment to a node)
        #[arg(long)]
        node_id: Option<String>,
        /// X coordinate (used when node_id is provided or for canvas pin)
        #[arg(long)]
        x: Option<f64>,
        /// Y coordinate (used when node_id is provided or for canvas pin)
        #[arg(long)]
        y: Option<f64>,
        /// Comment ID to reply to
        #[arg(long)]
        reply_to: Option<String>,
    },

    /// Delete a comment (figma_delete_comment)
    Delete {
        #[arg(long, env = "FIGMA_FILE_URL")]
        file: String,
        #[arg(long)]
        comment_id: String,
    },
}

pub async fn run(
    cmd: CommentsCommand,
    api: FigmaApi,
    format: &OutputFormat,
    quiet: bool,
) -> Result<()> {
    match cmd {
        CommentsCommand::List {
            file,
            include_resolved,
        } => {
            let key = parse_file_key(&file);
            let result = api.get_comments(&key, include_resolved).await?;
            print_output(&result, format, quiet);
        }

        CommentsCommand::Post {
            file,
            message,
            node_id,
            x,
            y,
            reply_to,
        } => {
            let key = parse_file_key(&file);
            let result = api
                .post_comment(
                    &key,
                    &message,
                    node_id.as_deref(),
                    x,
                    y,
                    reply_to.as_deref(),
                )
                .await?;
            print_output(&result, format, quiet);
        }

        CommentsCommand::Delete { file, comment_id } => {
            let key = parse_file_key(&file);
            let result = api.delete_comment(&key, &comment_id).await?;
            print_output(&result, format, quiet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_comments_module_compiles() {
        // Compilation check — commands are tested via integration
    }
}
