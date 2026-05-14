// Downloads the browser-trusted TLS cert pair that the playground origin
// uses in installed mode (https://local.hellofriday.ai:<port>). The certs
// are publicly issued by Let's Encrypt for `local.hellofriday.ai`, served
// from the CDN at download.fridayplatform.io, and rotate when LE re-issues
// — the manifest carries the current sha256 for each artifact so the
// installer can verify integrity before writing them to disk.
//
// File mapping (manifest filename → on-disk filename under tls-paths.ts
// resolution order):
//   fullchain.pem → <friday_home>/tls/browser.crt
//   key.pem       → <friday_home>/tls/browser.key  (0600 on Unix)
//
// The on-disk names match what `tls-paths.ts` (playground) and the
// launcher's TLS detection look for. The launcher and `playground_url`
// command also check for browser.crt to decide between
// https://local.hellofriday.ai:<port> and the legacy http://localhost
// fallback — so if this command fails, the rest of the install proceeds
// on http:// and the user is not blocked.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::friday_home::friday_home_dir;

const DEFAULT_MANIFEST_URL: &str = "https://download.fridayplatform.io/tls/manifest.json";

/// Filename inside the manifest's `files` map → on-disk filename under
/// `<friday_home>/tls/`. Single source of truth for the mapping so the
/// command code below stays a flat loop.
const FILES: &[(&str, &str)] = &[("fullchain.pem", "browser.crt"), ("key.pem", "browser.key")];

#[derive(Debug, Deserialize)]
struct Manifest {
    domain: String,
    #[serde(rename = "notAfter")]
    not_after: Option<String>,
    files: HashMap<String, FileEntry>,
}

#[derive(Debug, Deserialize)]
struct FileEntry {
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Serialize)]
pub struct TlsInstallReport {
    pub domain: String,
    pub cert_path: String,
    pub key_path: String,
    pub not_after: Option<String>,
}

fn manifest_url() -> String {
    std::env::var("FRIDAY_TLS_MANIFEST_URL").unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string())
}

fn tls_dir() -> Result<PathBuf, String> {
    Ok(friday_home_dir()?.join("tls"))
}

/// Atomic write: tmp + fsync + rename. Mirrors env_file.rs:atomic_write —
/// duplicated here so this module stays self-contained, and because the
/// cert pair has a stricter durability story (a torn cert.pem would mean
/// the playground fails to start TLS on next launch).
fn atomic_write(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("create parent dir {}: {e}", parent.display()))?;

    let tmp = path.with_extension({
        let existing = path.extension().map(|e| e.to_string_lossy().into_owned());
        match existing {
            Some(e) if !e.is_empty() => format!("{e}.tmp"),
            _ => "tmp".to_string(),
        }
    });
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }

    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("create tmp {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write tmp {}: {e}", tmp.display()))?;
        f.sync_data()
            .map_err(|e| format!("fsync tmp {}: {e}", tmp.display()))?;
    }

    // Set restrictive perms BEFORE the rename so the file is never visible
    // at the final path with a permissive mode. On Windows, fs::Permissions
    // ignores Unix bits — keys there are protected by the user's AppData
    // ACL inherited from the parent dir, which is sufficient.
    #[cfg(unix)]
    if let Some(m) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(m))
            .map_err(|e| format!("set perms on tmp {}: {e}", tmp.display()))?;
    }
    #[cfg(not(unix))]
    let _ = mode;

    fs::rename(&tmp, path).map_err(|e| {
        format!(
            "rename {} → {}: {e}",
            tmp.display(),
            path.display()
        )
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

async fn fetch_manifest(client: &reqwest::Client, url: &str) -> Result<Manifest, String> {
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("manifest fetch failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("manifest HTTP error: {}", res.status()));
    }
    res.json::<Manifest>()
        .await
        .map_err(|e| format!("manifest parse: {e}"))
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download {url}: HTTP {}", res.status()));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("read body {url}: {e}"))?;
    Ok(bytes.to_vec())
}

#[tauri::command]
pub async fn download_tls_certs() -> Result<TlsInstallReport, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build: {e}"))?;

    let url = manifest_url();
    let manifest = fetch_manifest(&client, &url).await?;

    let dir = tls_dir()?;
    let mut paths: HashMap<&str, PathBuf> = HashMap::new();

    for (manifest_name, on_disk_name) in FILES {
        let entry = manifest
            .files
            .get(*manifest_name)
            .ok_or_else(|| format!("manifest missing {manifest_name}"))?;

        let bytes = fetch_bytes(&client, &entry.url).await?;

        if bytes.len() as u64 != entry.size {
            return Err(format!(
                "{manifest_name}: size mismatch (got {}, manifest {})",
                bytes.len(),
                entry.size
            ));
        }

        let got = sha256_hex(&bytes);
        if !got.eq_ignore_ascii_case(&entry.sha256) {
            return Err(format!(
                "{manifest_name}: sha256 mismatch (got {got}, manifest {})",
                entry.sha256
            ));
        }

        let path = dir.join(on_disk_name);
        // The private key MUST be 0600 — the playground (Deno) reads it
        // directly and will accept any mode, but other users on the
        // machine should not be able to read a private key off disk.
        // fullchain is public, leave at default umask.
        let mode = if *on_disk_name == "browser.key" { Some(0o600) } else { None };
        atomic_write(&path, &bytes, mode)?;
        paths.insert(on_disk_name, path);
    }

    let cert_path = paths
        .get("browser.crt")
        .ok_or("internal: missing browser.crt path")?
        .display()
        .to_string();
    let key_path = paths
        .get("browser.key")
        .ok_or("internal: missing browser.key path")?
        .display()
        .to_string();

    Ok(TlsInstallReport {
        domain: manifest.domain,
        cert_path,
        key_path,
        not_after: manifest.not_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vector() {
        // "abc" → e9ec... (well-known SHA-256 vector).
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn atomic_write_round_trips_and_sets_mode() {
        let tmp = tempfile::tempdir().expect("create tmp");
        let p = tmp.path().join("nested").join("file.key");
        atomic_write(&p, b"hello", Some(0o600)).expect("write");
        assert_eq!(fs::read(&p).expect("read"), b"hello");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = fs::metadata(&p).expect("meta").permissions().mode() & 0o777;
            assert_eq!(m, 0o600);
        }
    }

    #[test]
    fn atomic_write_overwrites_existing() {
        let tmp = tempfile::tempdir().expect("create tmp");
        let p = tmp.path().join("file.crt");
        atomic_write(&p, b"v1", None).expect("v1");
        atomic_write(&p, b"v2", None).expect("v2");
        assert_eq!(fs::read(&p).expect("read"), b"v2");
    }
}
