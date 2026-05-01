use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[tauri::command]
pub async fn fetch_manifest(url: String) -> Result<Manifest, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Manifest fetch failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Manifest HTTP error: {}", response.status()));
    }

    let manifest: Manifest = response
        .json()
        .await
        .map_err(|e| format!("Manifest JSON parse error: {e}"))?;

    Ok(manifest)
}
