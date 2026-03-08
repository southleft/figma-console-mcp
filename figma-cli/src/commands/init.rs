use anyhow::{Context, Result};
use clap::Subcommand;
use colored::Colorize;
use std::path::PathBuf;

#[derive(Debug, Subcommand)]
pub enum InitCommand {
    /// Store credentials in ~/.figma-cli (default, affects all projects)
    Global {
        /// Figma personal access token
        #[arg(long, short)]
        token: String,

        /// Figma file URL (optional default file)
        #[arg(long)]
        file_url: Option<String>,
    },

    /// Store credentials in ./.env (current directory only, overrides global)
    Local {
        /// Figma personal access token
        #[arg(long, short)]
        token: String,

        /// Figma file URL (optional default file)
        #[arg(long)]
        file_url: Option<String>,
    },
}

pub fn global_config_path() -> PathBuf {
    dirs_home().join(".figma-cli")
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn load_global_config() {
    let path = global_config_path();
    if path.exists() {
        // Load as dotenv-style file (KEY=VALUE lines)
        let _ = dotenv::from_path(&path);
    }
}

pub async fn run(cmd: InitCommand) -> Result<()> {
    match cmd {
        InitCommand::Global { token, file_url } => {
            let path = global_config_path();
            write_config(&path, &token, file_url.as_deref())?;
            println!(
                "{} Global config saved to {}",
                "✓".green().bold(),
                path.display().to_string().cyan()
            );
            println!(
                "  {} All projects will use this token unless a local .env overrides it.",
                "→".dimmed()
            );
        }

        InitCommand::Local { token, file_url } => {
            let path = PathBuf::from(".env");
            let existed = path.exists();
            write_config_merge(&path, &token, file_url.as_deref())?;
            if existed {
                println!(
                    "{} Updated local config in {}",
                    "✓".green().bold(),
                    path.display().to_string().cyan()
                );
            } else {
                println!(
                    "{} Local config created at {}",
                    "✓".green().bold(),
                    path.display().to_string().cyan()
                );
            }
            println!(
                "  {} This directory's .env overrides the global ~/.figma-cli.",
                "→".dimmed()
            );
        }
    }

    Ok(())
}

/// Write a fresh config file (global, always overwrite).
fn write_config(path: &PathBuf, token: &str, file_url: Option<&str>) -> Result<()> {
    let mut content = format!("FIGMA_ACCESS_TOKEN={}\n", token);
    if let Some(url) = file_url {
        content.push_str(&format!("FIGMA_FILE_URL={}\n", url));
    }
    std::fs::write(path, &content)
        .with_context(|| format!("Failed to write config to {}", path.display()))?;
    Ok(())
}

/// Merge into an existing .env (preserves other vars, updates FIGMA_* keys).
fn write_config_merge(path: &PathBuf, token: &str, file_url: Option<&str>) -> Result<()> {
    // Read existing content if present
    let existing = if path.exists() {
        std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?
    } else {
        String::new()
    };

    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| {
            !l.starts_with("FIGMA_ACCESS_TOKEN=") && !l.starts_with("FIGMA_FILE_URL=")
        })
        .map(String::from)
        .collect();

    lines.push(format!("FIGMA_ACCESS_TOKEN={}", token));
    if let Some(url) = file_url {
        lines.push(format!("FIGMA_FILE_URL={}", url));
    }

    let mut out = lines.join("\n");
    out.push('\n');

    std::fs::write(path, &out)
        .with_context(|| format!("Failed to write {}", path.display()))?;
    Ok(())
}
