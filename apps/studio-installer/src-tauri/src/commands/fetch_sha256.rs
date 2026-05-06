// fetch_sha256 — fetch a `<artifact>.sha256` sibling file and return the
// hex digest as a plain string.
//
// Used by the installer's dev-version-override path: when the tester
// pins a specific studio version via the hidden Welcome-screen panel,
// the installer constructs the artifact URL by convention and fetches
// the `.sha256` next to it so SHA-256 verification stays on.
// `studio-build.yml`'s upload step writes both the archive and the
// `.sha256` (line 293) so the file is always present for any version
// that has a corresponding artifact.
//
// Format expected: `<hex-digest>  <filename>` — the standard
// `shasum -a 256` / `sha256sum` output. We split on whitespace and
// take the first token.

#[tauri::command]
pub async fn fetch_sha256(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("SHA-256 fetch failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "SHA-256 file not found ({}) — does the version exist? URL: {url}",
            response.status()
        ));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("SHA-256 read body: {e}"))?;

    // Standard `shasum -a 256` output is `<hex>  <filename>`. Take the
    // first whitespace-delimited token. Reject empty / malformed.
    let hash = text.split_whitespace().next().unwrap_or("");
    if hash.is_empty() {
        return Err(format!("SHA-256 file empty or malformed: {text:?}"));
    }
    // Hex digest for SHA-256 is 64 chars. Reject obvious garbage early
    // so we surface a useful error before the verify step compares
    // against a bad value.
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("SHA-256 file does not contain a hex digest: {hash:?}"));
    }
    Ok(hash.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Smoke tests for the parsing branches. The HTTP path is exercised
    // end-to-end manually + by the existing fetch_manifest tests.

    fn parse(text: &str) -> Result<String, String> {
        let hash = text.split_whitespace().next().unwrap_or("");
        if hash.is_empty() {
            return Err(format!("SHA-256 file empty or malformed: {text:?}"));
        }
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("SHA-256 file does not contain a hex digest: {hash:?}"));
        }
        Ok(hash.to_string())
    }

    #[test]
    fn parses_standard_shasum_output() {
        let body =
            "7ce7932cd6443d58d17d8459aee751b4dd407b61e5e9aee3bdc00f09c01a82a3  artifact.tar.zst\n";
        assert_eq!(
            parse(body).unwrap(),
            "7ce7932cd6443d58d17d8459aee751b4dd407b61e5e9aee3bdc00f09c01a82a3"
        );
    }

    #[test]
    fn parses_hash_only() {
        // Some tools emit the hash with no filename — handle both.
        let body = "7ce7932cd6443d58d17d8459aee751b4dd407b61e5e9aee3bdc00f09c01a82a3\n";
        assert_eq!(
            parse(body).unwrap(),
            "7ce7932cd6443d58d17d8459aee751b4dd407b61e5e9aee3bdc00f09c01a82a3"
        );
    }

    #[test]
    fn rejects_empty() {
        assert!(parse("").is_err());
        assert!(parse("\n").is_err());
        assert!(parse("   ").is_err());
    }

    #[test]
    fn rejects_non_hex() {
        // 64 chars but contains a non-hex character.
        let bad = "7ce7932cd6443d58d17d8459aee751b4dd407b61e5e9aee3bdc00f09c01a82aZ";
        assert!(parse(bad).is_err());
    }

    #[test]
    fn rejects_wrong_length() {
        // Truncated hash.
        let short = "7ce7932cd6443d58d17d8459aee751b4";
        assert!(parse(short).is_err());
    }
}
