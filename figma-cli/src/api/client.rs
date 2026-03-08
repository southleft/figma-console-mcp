/// HTTP client for the Figma REST API.
use anyhow::{Context, Result, bail};
use serde_json::Value;

const FIGMA_BASE_URL: &str = "https://api.figma.com/v1";

/// A configured HTTP client for the Figma REST API.
///
/// Wraps `reqwest::Client` with the access token and base URL so individual
/// request methods don't have to repeat authentication headers.
#[derive(Debug)]
pub struct FigmaApiClient {
    http: reqwest::Client,
    token: String,
    base_url: String,
}

impl FigmaApiClient {
    /// Create a new client with the given access token.
    pub fn new(token: impl Into<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .context("failed to build HTTP client")?;

        Ok(Self {
            http,
            token: token.into(),
            base_url: FIGMA_BASE_URL.to_string(),
        })
    }

    /// Issue a GET request to the given API path and return the parsed body.
    pub async fn get(&self, path: &str) -> Result<Value> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .get(&url)
            .header("X-Figma-Token", &self.token)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .context("failed to read response body")?;

        if !status.is_success() {
            bail!("Figma API error {status}: {body}");
        }

        serde_json::from_str(&body)
            .with_context(|| format!("failed to parse response from GET {url}"))
    }

    /// Issue a POST request with a JSON body.
    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .post(&url)
            .header("X-Figma-Token", &self.token)
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .context("failed to read response body")?;

        if !status.is_success() {
            bail!("Figma API error {status}: {text}");
        }

        serde_json::from_str(&text)
            .with_context(|| format!("failed to parse response from POST {url}"))
    }

    /// Issue a DELETE request.
    pub async fn delete(&self, path: &str) -> Result<Value> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .delete(&url)
            .header("X-Figma-Token", &self.token)
            .send()
            .await
            .with_context(|| format!("DELETE {url}"))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .context("failed to read response body")?;

        if !status.is_success() {
            bail!("Figma API error {status}: {text}");
        }

        // Figma returns 200 with JSON or 204 with empty body on delete
        if text.trim().is_empty() {
            Ok(serde_json::json!({"status": "deleted"}))
        } else {
            serde_json::from_str(&text)
                .with_context(|| format!("failed to parse response from DELETE {url}"))
        }
    }
}

/// Extract a Figma file key from a URL or return the input unchanged.
///
/// Figma file URLs follow the pattern:
/// `https://www.figma.com/design/<FILE_KEY>/...`
///
/// If the input does not look like a URL, it is treated as a raw file key.
///
/// # Examples
///
/// ```
/// use figma_cli::api::client::parse_file_key;
///
/// let key = parse_file_key("https://www.figma.com/design/AbCd1234/my-file");
/// assert_eq!(key, "AbCd1234");
///
/// let key = parse_file_key("AbCd1234");
/// assert_eq!(key, "AbCd1234");
/// ```
pub fn parse_file_key(input: &str) -> String {
    // Match /design/<key>/ or /file/<key>/ patterns
    for prefix in ["/design/", "/file/"] {
        if let Some(after) = input.find(prefix).map(|i| &input[i + prefix.len()..]) {
            let key = after.split('/').next().unwrap_or(after);
            if !key.is_empty() {
                return key.to_string();
            }
        }
    }
    input.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_file_key_from_design_url() {
        let url = "https://www.figma.com/design/AbCd1234XyZ/my-design-file";
        assert_eq!(parse_file_key(url), "AbCd1234XyZ");
    }

    #[test]
    fn test_parse_file_key_from_file_url() {
        let url = "https://www.figma.com/file/AbCd1234XyZ/my-file?node-id=0%3A1";
        assert_eq!(parse_file_key(url), "AbCd1234XyZ");
    }

    #[test]
    fn test_parse_file_key_passthrough() {
        assert_eq!(parse_file_key("AbCd1234XyZ"), "AbCd1234XyZ");
    }

    #[test]
    fn test_parse_file_key_empty_segment() {
        // Malformed URL — falls back to full string
        assert_eq!(parse_file_key("https://example.com/design/"), "https://example.com/design/");
    }
}
