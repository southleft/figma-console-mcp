mod api;
mod cli;
mod commands;
mod output;

use anyhow::{Context, Result};
use clap::Parser;

use api::{client::FigmaApiClient, figma::FigmaApi};
use cli::{Cli, Command};
use output::print_error;

#[tokio::main]
async fn main() {
    // Load .env from the current directory (silently ignored if absent)
    let _ = dotenv::dotenv();

    if let Err(e) = run().await {
        print_error(&format!("{e:#}"));
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();

    // Extract fields before moving cli.command
    let token = cli.token;
    let output = cli.output;
    let quiet = cli.quiet;
    let verbose = cli.verbose;

    let start = std::time::Instant::now();

    match cli.command {
        // Commands that do not require an API token
        Command::Desktop { cmd } => {
            commands::desktop::run(cmd).await?;
        }

        Command::Execute { cmd } => {
            commands::execute::run(cmd).await?;
        }

        // All remaining commands need a Figma access token
        cmd => {
            let raw_token = token.context(
                "Figma access token required. Set FIGMA_ACCESS_TOKEN or pass --token.",
            )?;

            let client = FigmaApiClient::new(&raw_token)?;
            let api = FigmaApi::new(client);

            match cmd {
                Command::File { cmd } => {
                    commands::file::run(cmd, api, &output, quiet).await?;
                }
                Command::Variables { cmd } => {
                    commands::variables::run(cmd, api, &output, quiet).await?;
                }
                Command::Components { cmd } => {
                    commands::components::run(cmd, api, &output, quiet).await?;
                }
                Command::Styles { cmd } => {
                    commands::styles::run(cmd, api, &output, quiet).await?;
                }
                Command::Comments { cmd } => {
                    commands::comments::run(cmd, api, &output, quiet).await?;
                }
                Command::DesignSystem { cmd } => {
                    commands::design_system::run(cmd, api, &output, quiet).await?;
                }
                Command::Nodes { cmd } => {
                    commands::nodes::run(cmd, api, &output, quiet).await?;
                }
                // Already handled above
                Command::Desktop { .. } | Command::Execute { .. } => unreachable!(),
            }
        }
    }

    if verbose {
        eprintln!("request completed in {:.0}ms", start.elapsed().as_millis());
    }

    Ok(())
}
