// Integration test reproducing the v6 plan's promised contract:
// `write_env_file` with a non-Anthropic provider key must create
// `~/.friday/local/friday.yml` with the wizard's per-provider models
// matrix. The 2026-04-30 VM repro showed friday.yml missing despite
// .env being correctly written; this test catches that regression at
// the integration layer (entry-point command, real path resolution
// via dirs::home_dir() with HOME overridden to a tempdir).

use std::env;
use std::fs;

use studio_installer_lib::commands::env_file::write_env_file;
use tempfile::TempDir;

#[test]
fn write_env_with_openai_key_creates_friday_yml() {
    let tmp = TempDir::new().unwrap();
    // dirs::home_dir() on macOS reads $HOME first.
    // SAFETY: tests in a single Cargo target run in-process; we don't
    // run this concurrently with anything that depends on $HOME.
    unsafe {
        env::set_var("HOME", tmp.path());
    }

    let result = write_env_file(
        None,
        Some("sk-test-openai".to_string()),
        None,
        None,
    );
    assert!(result.is_ok(), "write_env_file failed: {:?}", result);

    let env_path = tmp.path().join(".friday/local/.env");
    let yml_path = tmp.path().join(".friday/local/friday.yml");

    assert!(env_path.exists(), ".env should exist at {}", env_path.display());
    let env_content = fs::read_to_string(&env_path).unwrap();
    assert!(env_content.contains("OPENAI_API_KEY=sk-test-openai"));

    assert!(
        yml_path.exists(),
        "friday.yml should exist at {} — this is the bug the v6 plan targets",
        yml_path.display(),
    );
    let yml = fs::read_to_string(&yml_path).unwrap();
    assert!(yml.contains("openai:gpt-5.5"), "friday.yml missing OpenAI matrix:\n{yml}");
    assert!(yml.contains("models:"), "friday.yml missing models block:\n{yml}");
}

#[test]
fn write_env_with_anthropic_key_does_not_create_friday_yml() {
    let tmp = TempDir::new().unwrap();
    unsafe {
        env::set_var("HOME", tmp.path());
    }

    let result = write_env_file(
        Some("sk-ant-test".to_string()),
        None,
        None,
        None,
    );
    assert!(result.is_ok(), "write_env_file failed: {:?}", result);

    let env_path = tmp.path().join(".friday/local/.env");
    let yml_path = tmp.path().join(".friday/local/friday.yml");

    assert!(env_path.exists());
    // Anthropic uses the daemon's default chain — no friday.yml needed.
    assert!(
        !yml_path.exists(),
        "friday.yml should NOT exist for Anthropic-only path",
    );
}
