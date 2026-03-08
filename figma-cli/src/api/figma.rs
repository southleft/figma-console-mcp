/// High-level Figma API methods built on top of `FigmaApiClient`.
use anyhow::Result;
use serde_json::{Value, json};

use super::client::FigmaApiClient;

/// Figma API operations.
///
/// Each method corresponds to one or more Figma REST API endpoints and
/// returns the raw JSON response so callers can format it as needed.
pub struct FigmaApi {
    client: FigmaApiClient,
}

impl FigmaApi {
    pub fn new(client: FigmaApiClient) -> Self {
        Self { client }
    }

    /// Fetch the full file document.
    ///
    /// `node_ids` and `depth` are optional query parameters.
    pub async fn get_file(
        &self,
        file_key: &str,
        depth: Option<u32>,
        node_ids: Option<&[String]>,
    ) -> Result<Value> {
        let mut params = vec![];
        if let Some(d) = depth {
            params.push(format!("depth={d}"));
        }
        if let Some(ids) = node_ids {
            if !ids.is_empty() {
                params.push(format!("ids={}", ids.join(",")));
            }
        }
        let query = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        self.client.get(&format!("/files/{file_key}{query}")).await
    }

    /// Fetch all local styles in a file.
    pub async fn get_styles(&self, file_key: &str) -> Result<Value> {
        self.client.get(&format!("/files/{file_key}/styles")).await
    }

    /// Fetch all local components in a file.
    pub async fn get_components(&self, file_key: &str) -> Result<Value> {
        self.client
            .get(&format!("/files/{file_key}/components"))
            .await
    }

    /// Fetch component sets (variants) in a file.
    pub async fn get_component_sets(&self, file_key: &str) -> Result<Value> {
        self.client
            .get(&format!("/files/{file_key}/component_sets"))
            .await
    }

    /// Fetch a single component by its node key.
    pub async fn get_component(&self, component_key: &str) -> Result<Value> {
        self.client
            .get(&format!("/components/{component_key}"))
            .await
    }

    /// Fetch local variables for a file (requires Enterprise plan).
    pub async fn get_variables(&self, file_key: &str) -> Result<Value> {
        self.client
            .get(&format!("/files/{file_key}/variables/local"))
            .await
    }

    /// Publish variable changes to a file.
    pub async fn post_variables(&self, file_key: &str, payload: &Value) -> Result<Value> {
        self.client
            .post(&format!("/files/{file_key}/variables"), payload)
            .await
    }

    /// Fetch comments on a file.
    ///
    /// Note: the Figma REST API does not expose a filter for resolved comments
    /// — all comments are returned and callers may filter client-side.
    pub async fn get_comments(&self, file_key: &str, _include_resolved: bool) -> Result<Value> {
        self.client
            .get(&format!("/files/{file_key}/comments?as_md=false"))
            .await
    }

    /// Post a comment on a file.
    pub async fn post_comment(
        &self,
        file_key: &str,
        message: &str,
        node_id: Option<&str>,
        x: Option<f64>,
        y: Option<f64>,
        reply_to: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "message": message });
        if let Some(id) = node_id {
            body["client_meta"] = json!({
                "node_id": id,
                "node_offset": { "x": x.unwrap_or(0.0), "y": y.unwrap_or(0.0) }
            });
        } else if let (Some(x), Some(y)) = (x, y) {
            body["client_meta"] = json!({ "x": x, "y": y });
        }
        if let Some(reply) = reply_to {
            body["comment_id"] = json!(reply);
        }
        self.client
            .post(&format!("/files/{file_key}/comments"), &body)
            .await
    }

    /// Delete a comment.
    pub async fn delete_comment(&self, file_key: &str, comment_id: &str) -> Result<Value> {
        self.client
            .delete(&format!("/files/{file_key}/comments/{comment_id}"))
            .await
    }

    /// Fetch specific nodes from a file.
    pub async fn get_nodes(
        &self,
        file_key: &str,
        node_ids: &[String],
        depth: Option<u32>,
    ) -> Result<Value> {
        let mut params = vec![format!("ids={}", node_ids.join(","))];
        if let Some(d) = depth {
            params.push(format!("depth={d}"));
        }
        let query = params.join("&");
        self.client
            .get(&format!("/files/{file_key}/nodes?{query}"))
            .await
    }

    /// Fetch rendered images for nodes.
    pub async fn get_images(
        &self,
        file_key: &str,
        node_ids: &[String],
        scale: Option<f64>,
        format: Option<&str>,
    ) -> Result<Value> {
        let ids = node_ids.join(",");
        let scale_str = scale.unwrap_or(1.0).to_string();
        let fmt = format.unwrap_or("png");
        self.client
            .get(&format!(
                "/images/{file_key}?ids={ids}&scale={scale_str}&format={fmt}"
            ))
            .await
    }

    /// Fetch the design system manifest from a published library file.
    pub async fn get_file_for_plugin(&self, file_key: &str) -> Result<Value> {
        // Returns the full file suitable for plugin consumption (same endpoint, different use)
        self.get_file(file_key, Some(3), None).await
    }

    /// Execute a raw GET request against an arbitrary API path.
    ///
    /// `path` must be relative to `https://api.figma.com/v1`, e.g. `/files/KEY/components`.
    pub async fn get_raw(&self, path: &str) -> Result<Value> {
        self.client.get(path).await
    }

    /// Execute a raw POST request against an arbitrary API path.
    ///
    /// `path` must be relative to `https://api.figma.com/v1`.
    pub async fn post_raw(&self, path: &str, body: &Value) -> Result<Value> {
        self.client.post(path, body).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::client::FigmaApiClient;

    fn make_api() -> FigmaApi {
        let client = FigmaApiClient::new("test-token").expect("client");
        FigmaApi::new(client)
    }

    #[test]
    fn test_figma_api_construction() {
        let _api = make_api();
    }

    #[tokio::test]
    async fn test_get_file_url_depth() {
        // This test is intentionally a compilation check — it would fail at
        // runtime without a valid token, so we don't call .await on it in CI.
        let api = make_api();
        // Verify the method exists and accepts the right types
        let _ = api.get_file("KEY", Some(2), None);
        let _ = api.get_file("KEY", None, Some(&["0:1".to_string()]));
    }
}
