/// Output formatting utilities for the Figma CLI.
///
/// Supports three output modes:
/// - `pretty`: Colored, human-readable JSON
/// - `json`: Raw JSON (suitable for piping)
/// - `table`: Tabular representation for array data
use colored::Colorize;
use comfy_table::{Table, presets::UTF8_FULL};
use serde_json::Value;

/// Output format selected by the user.
#[derive(Debug, Clone, clap::ValueEnum, Default)]
pub enum OutputFormat {
    #[default]
    Pretty,
    Json,
    Table,
}

/// Print a JSON value using the selected output format.
pub fn print_output(value: &Value, format: &OutputFormat, quiet: bool) {
    if quiet {
        println!("{}", serde_json::to_string(value).unwrap_or_default());
        return;
    }

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string(value).unwrap_or_default());
        }
        OutputFormat::Pretty => {
            print_json(value);
        }
        OutputFormat::Table => {
            if let Some(arr) = value.as_array() {
                print_array_as_table(arr);
            } else if let Some(obj) = value.as_object() {
                print_object_as_table(obj);
            } else {
                print_json(value);
            }
        }
    }
}

/// Print a JSON value with syntax-like coloring.
pub fn print_json(value: &Value) {
    let formatted = serde_json::to_string_pretty(value).unwrap_or_default();
    for line in formatted.lines() {
        println!("{}", colorize_json_line(line));
    }
}

fn colorize_json_line(line: &str) -> String {
    let trimmed = line.trim_start();

    // Key-value pair: "key": value
    if let Some(colon_pos) = trimmed.find("\": ") {
        let prefix = &line[..line.len() - trimmed.len()];
        let key_end = colon_pos + 1; // include the closing quote
        let key_part = &trimmed[..key_end];
        let rest = &trimmed[colon_pos + 3..];
        let colored_rest = colorize_json_value(rest);
        return format!("{}{}: {}", prefix, key_part.cyan(), colored_rest);
    }

    // Plain value (array element etc.)
    format!("{}{}", &line[..line.len() - trimmed.len()], colorize_json_value(trimmed))
}

fn colorize_json_value(s: &str) -> String {
    let value_part = s.trim_end_matches([',', ' ']);
    let suffix = &s[value_part.len()..];

    let colored = if value_part.starts_with('"') {
        value_part.green().to_string()
    } else if value_part == "true" || value_part == "false" {
        value_part.yellow().to_string()
    } else if value_part == "null" {
        value_part.bright_black().to_string()
    } else if value_part.parse::<f64>().is_ok() {
        value_part.magenta().to_string()
    } else {
        value_part.to_string()
    };

    format!("{}{}", colored, suffix)
}

/// Print an array of JSON objects as a table, using top-level keys as headers.
pub fn print_array_as_table(arr: &[Value]) {
    if arr.is_empty() {
        println!("{}", "No items found.".bright_black());
        return;
    }

    // Collect headers from first object
    let headers: Vec<String> = match arr.first().and_then(|v| v.as_object()) {
        Some(obj) => obj.keys().take(8).cloned().collect(),
        None => {
            // Plain values — print as single-column table
            print_values_as_table(arr);
            return;
        }
    };

    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_header(headers.iter().map(|h| h.as_str().bold().to_string()));

    for item in arr {
        if let Some(obj) = item.as_object() {
            let row: Vec<String> = headers
                .iter()
                .map(|h| format_cell_value(obj.get(h)))
                .collect();
            table.add_row(row);
        }
    }

    println!("{table}");
}

fn print_values_as_table(arr: &[Value]) {
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_header(["value"]);
    for v in arr {
        table.add_row([format_cell_value(Some(v))]);
    }
    println!("{table}");
}

/// Print a single JSON object as a two-column key/value table.
pub fn print_object_as_table(obj: &serde_json::Map<String, Value>) {
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_header(["key".bold().to_string(), "value".bold().to_string()]);

    for (k, v) in obj {
        table.add_row([k.cyan().to_string(), format_cell_value(Some(v))]);
    }

    println!("{table}");
}

fn format_cell_value(v: Option<&Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::Null) => "null".bright_black().to_string(),
        Some(Value::Bool(b)) => b.to_string().yellow().to_string(),
        Some(Value::Number(n)) => n.to_string().magenta().to_string(),
        Some(Value::String(s)) => {
            // Truncate long strings for table display
            if s.len() > 60 {
                format!("{}...", &s[..57]).green().to_string()
            } else {
                s.green().to_string()
            }
        }
        Some(Value::Array(arr)) => format!("[{} items]", arr.len()).bright_black().to_string(),
        Some(Value::Object(_)) => "{...}".bright_black().to_string(),
    }
}

/// Print an error message to stderr.
pub fn print_error(msg: &str) {
    eprintln!("{} {}", "error:".red().bold(), msg);
}

/// Print a success message.
pub fn print_success(msg: &str) {
    println!("{} {}", "ok:".green().bold(), msg);
}

/// Print a warning message.
pub fn print_warning(msg: &str) {
    println!("{} {}", "warn:".yellow().bold(), msg);
}

/// Print a desktop bridge stub message.
pub fn print_desktop_stub(port: u16) {
    println!(
        "{} This command requires the Figma Desktop Bridge plugin.",
        "info:".cyan().bold()
    );
    println!(
        "     Connect at {}",
        format!("ws://localhost:{port}/ws").cyan()
    );
    println!();
    println!("     Install the plugin from: https://github.com/sonnylazuardi/figma-desktop-bridge");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_print_output_json_format() {
        // Should not panic
        let v = json!({"key": "value", "num": 42});
        print_output(&v, &OutputFormat::Json, false);
    }

    #[test]
    fn test_print_output_quiet() {
        let v = json!({"key": "value"});
        print_output(&v, &OutputFormat::Pretty, true);
    }

    #[test]
    fn test_print_array_as_table_empty() {
        // Should not panic
        print_array_as_table(&[]);
    }

    #[test]
    fn test_print_array_as_table_objects() {
        let arr = vec![
            json!({"id": "1", "name": "Component A"}),
            json!({"id": "2", "name": "Component B"}),
        ];
        print_array_as_table(&arr);
    }

    #[test]
    fn test_format_cell_value_truncates_long_string() {
        let long = Value::String("a".repeat(100));
        let result = format_cell_value(Some(&long));
        // ANSI codes add length, but the string portion should be truncated
        assert!(result.contains("..."));
    }

    #[test]
    fn test_colorize_json_line_key_value() {
        let line = "  \"name\": \"figma\"";
        let result = colorize_json_line(line);
        assert!(result.contains("name") && result.contains("figma"));
    }
}
