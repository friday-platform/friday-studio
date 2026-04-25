use sha2::{Digest, Sha256};
use std::io::Read;

const CHUNK_SIZE: usize = 64 * 1024; // 64 KB

#[tauri::command]
pub fn verify_sha256(path: String, expected_hash: String) -> Result<bool, String> {
    let mut file =
        std::fs::File::open(&path).map_err(|e| format!("Failed to open file for verify: {e}"))?;

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK_SIZE];

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Read error during verify: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    let digest = hasher.finalize();
    let hex_digest = hex::encode(digest);

    Ok(hex_digest.eq_ignore_ascii_case(&expected_hash))
}
