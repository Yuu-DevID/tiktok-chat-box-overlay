use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Everything the app needs to know, saved as JSON next to the binary (or in
/// ~/.config/tiktok-live-reader when no local config exists). The UI edits
/// this through `POST /api/config`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// TikTok account whose LIVE chat is read. Empty means "not set up yet",
    /// which is what gates the dashboard behind the setup screen.
    pub tiktok_username: String,
    /// Euler Stream sign key. Optional, but without it the connector falls
    /// back to a shared quota and often gets throttled.
    pub sign_api_key: String,
    /// Optional authenticated session (sessionid + tt-target-idc cookies).
    pub session_id: String,
    pub tt_target_idc: String,

    pub youtube_api_key: String,
    pub youtube_region: String,
    pub song_max_duration_sec: u64,

    pub easydonate_api_key: String,
    pub easydonate_api_base_url: String,
    pub tts_engine_url: String,

    /// Optional helper that creates a TikTok LIVE room and prints the RTMP
    /// server + stream key. Spawned with python3.
    pub tiktok_live_script: String,
    pub tiktok_live_cookies: String,
    pub tiktok_live_title: String,
    pub tiktok_live_topic: String,
    pub tiktok_live_region: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tiktok_username: String::new(),
            sign_api_key: String::new(),
            session_id: String::new(),
            tt_target_idc: String::new(),
            youtube_api_key: String::new(),
            youtube_region: "ID".into(),
            song_max_duration_sec: 600,
            easydonate_api_key: String::new(),
            easydonate_api_base_url: "https://api.easydonate.app".into(),
            tts_engine_url: "http://127.0.0.1:8000/v1/tts".into(),
            tiktok_live_script: String::new(),
            tiktok_live_cookies: String::new(),
            tiktok_live_title: String::new(),
            tiktok_live_topic: String::new(),
            tiktok_live_region: String::new(),
        }
    }
}

impl Config {
    pub fn configured(&self, mock: bool) -> bool {
        mock || !self.tiktok_username.trim().is_empty()
    }

    pub fn username_clean(&self) -> String {
        normalize_username(&self.tiktok_username)
    }

    pub fn filler_path(config_path: &Path) -> PathBuf {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("filler-songs.json")
    }

    pub fn extra_donors_path(config_path: &Path) -> PathBuf {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("extra-donors.json")
    }

    pub fn donor_aliases_path(config_path: &Path) -> PathBuf {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("donor-aliases.json")
    }

    pub fn live_log_dir() -> PathBuf {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("logs")
    }
}

/// Accepts `user`, `@user`, a profile URL or a live URL and returns the bare
/// handle. Keeps pasted links from the setup form working.
pub fn normalize_username(input: &str) -> String {
    let mut value = input.trim();
    if let Some(idx) = value.find("@") {
        value = &value[idx + 1..];
    }
    for stop in ['/', '?', '#'] {
        if let Some(idx) = value.find(stop) {
            value = &value[..idx];
        }
    }
    value.trim().trim_start_matches('@').to_string()
}

/// Config location rules, in order:
/// 1. `--config` / `TIKTOK_READER_CONFIG`
/// 2. `./config.json` when it already exists (repo / portable setup)
/// 3. `$XDG_CONFIG_HOME/tiktok-live-reader/config.json`
pub fn resolve_config_path(explicit: Option<&str>) -> PathBuf {
    if let Some(path) = explicit {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::var("TIKTOK_READER_CONFIG") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    let local = PathBuf::from("config.json");
    if local.exists() {
        return local;
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("tiktok-live-reader").join("config.json")
}

pub fn load(path: &Path, seed_env: bool) -> Config {
    if let Ok(raw) = fs::read_to_string(path) {
        match serde_json::from_str::<Config>(&raw) {
            Ok(config) => return config,
            Err(err) => tracing::warn!("config.json is not valid ({err}); ignoring it"),
        }
    }
    // First Rust run: carry over the old Node .env so the user does not have
    // to retype keys that already sit in the project folder. An explicit
    // --config path starts clean, which also makes the setup gate testable.
    if !seed_env {
        return Config::default();
    }
    let seeded = from_dotenv();
    if seeded.tiktok_username.is_empty() && seeded.youtube_api_key.is_empty() {
        Config::default()
    } else {
        seeded
    }
}

fn from_dotenv() -> Config {
    let mut config = Config::default();
    let mut values: HashMap<String, String> = HashMap::new();
    for candidate in [
        PathBuf::from(".env"),
        PathBuf::from("../.env"),
        PathBuf::from("../../.env"),
    ] {
        if let Ok(raw) = fs::read_to_string(&candidate) {
            for line in raw.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    values.insert(
                        key.trim().to_string(),
                        value.trim().trim_matches('"').trim_matches('\'').to_string(),
                    );
                }
            }
            break;
        }
    }
    let get = |key: &str| values.get(key).cloned().unwrap_or_default();
    config.tiktok_username = normalize_username(&get("TIKTOK_USERNAME"));
    config.youtube_api_key = get("YOUTUBE_API_KEY");
    config.easydonate_api_key = get("EASYDONATE_API_KEY");
    if !get("YOUTUBE_REGION").is_empty() {
        config.youtube_region = get("YOUTUBE_REGION");
    }
    if let Ok(max) = get("SONG_MAX_DURATION_SEC").parse::<u64>() {
        config.song_max_duration_sec = max;
    }
    if !get("TTS_ENGINE_URL").is_empty() {
        config.tts_engine_url = get("TTS_ENGINE_URL");
    }
    if !get("TIKTOK_LIVE_PY").is_empty() {
        config.tiktok_live_script = get("TIKTOK_LIVE_PY");
    }
    config
}

pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let json = serde_json::to_string_pretty(config).unwrap_or_else(|_| "{}".into());
    fs::write(path, format!("{json}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_and_links_become_handles() {
        assert_eq!(normalize_username("@yu.desuwa"), "yu.desuwa");
        assert_eq!(
            normalize_username("https://www.tiktok.com/@yu.desuwa/live?lang=en"),
            "yu.desuwa"
        );
        assert_eq!(normalize_username("  user_888  "), "user_888");
    }

    #[test]
    fn defaults_match_the_documented_shape() {
        let config = Config::default();
        assert_eq!(config.song_max_duration_sec, 600);
        assert_eq!(config.youtube_region, "ID");
        assert!(!config.configured(false));
        assert!(config.configured(true));
    }
}
