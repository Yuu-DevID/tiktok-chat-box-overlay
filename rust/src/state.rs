use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use tokio::sync::broadcast;

use crate::config::Config;
use crate::live_log::LiveLog;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub video_id: String,
    pub title: String,
    #[serde(default)]
    pub channel: String,
    pub duration_sec: u64,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub is_filler: bool,
    #[serde(default)]
    pub requested_at: i64,
}

#[derive(Default)]
pub struct Stats {
    pub comments: u64,
    pub gifts: u64,
    pub gift_diamonds: u64,
    pub viewers: HashSet<String>,
    pub gifters: HashMap<String, Gifter>,
}

pub struct Gifter {
    pub nickname: String,
    pub diamonds: u64,
}

pub struct Songs {
    pub enabled: bool,
    pub auto_approve: bool,
    pub pending: Vec<Song>,
    pub approved: Vec<Song>,
    pub now_playing: Option<Song>,
    pub recent_video_ids: Vec<String>,
    pub fillers: Vec<Song>,
    pub filler_cursor: usize,
}

pub struct Tts {
    pub provider: String,
    pub lang: String,
    pub enabled: bool,
    pub speed: f64,
    pub read_chance: f64,
}

pub struct Timer {
    pub status: String,
    pub duration_ms: i64,
    pub ends_at: Option<i64>,
    pub remaining_ms: Option<i64>,
    pub message: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ConnStatus {
    Offline,
    Connecting,
    Live,
    Error,
}

impl ConnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ConnStatus::Offline => "offline",
            ConnStatus::Connecting => "connecting",
            ConnStatus::Live => "live",
            ConnStatus::Error => "error",
        }
    }
}

#[derive(Clone)]
pub struct Conn {
    pub status: ConnStatus,
    pub detail: String,
    pub attempts: u32,
    pub username: String,
    pub room_id: Option<String>,
}

impl Default for Conn {
    fn default() -> Self {
        Self {
            status: ConnStatus::Offline,
            detail: String::new(),
            attempts: 0,
            username: String::new(),
            room_id: None,
        }
    }
}

pub struct AppState {
    pub config: RwLock<Config>,
    pub config_path: PathBuf,
    pub tx: broadcast::Sender<String>,
    pub stats: Mutex<Stats>,
    pub songs: Mutex<Songs>,
    pub tts: Mutex<Tts>,
    pub timer: Mutex<Timer>,
    pub conn: RwLock<Conn>,
    pub mock: bool,
    pub mock_chat: bool,
    pub live_log: LiveLog,
    pub http: reqwest::Client,
    pub fillers_path: PathBuf,
    pub tiktok_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub port: u16,
    log_seq: AtomicU64,
    song_seq: AtomicU64,
}

impl AppState {
    pub fn new(
        mut config: Config,
        config_path: PathBuf,
        port: u16,
        mock: bool,
        mock_chat: bool,
    ) -> Self {
        let (tx, _) = broadcast::channel(512);
        let fillers_path = Config::filler_path(&config_path);
        let fillers = load_fillers(&fillers_path);
        let songs_enabled = !config.youtube_api_key.trim().is_empty();
        config.tiktok_username = crate::config::normalize_username(&config.tiktok_username);
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("TikTokLiveReader/0.2 (+https://github.com/Yuu-DevID/tiktok-chat-box-overlay)")
            .build()
            .unwrap_or_default();
        Self {
            config: RwLock::new(config),
            config_path,
            tx,
            stats: Mutex::new(Stats::default()),
            songs: Mutex::new(Songs {
                enabled: songs_enabled,
                auto_approve: true,
                pending: Vec::new(),
                approved: Vec::new(),
                now_playing: None,
                recent_video_ids: Vec::new(),
                fillers,
                filler_cursor: 0,
            }),
            tts: Mutex::new(Tts {
                provider: "google".into(),
                lang: "en".into(),
                enabled: true,
                speed: 1.5,
                read_chance: 1.0,
            }),
            timer: Mutex::new(Timer {
                status: "idle".into(),
                duration_ms: 300_000,
                ends_at: None,
                remaining_ms: None,
                message: "Be right back — grab a drink and stay tuned!".into(),
            }),
            conn: RwLock::new(Conn::default()),
            mock,
            mock_chat,
            live_log: LiveLog::new(Config::live_log_dir()),
            http,
            fillers_path,
            tiktok_task: Mutex::new(None),
            port,
            log_seq: AtomicU64::new(1),
            song_seq: AtomicU64::new(1),
        }
    }

    pub fn config_snapshot(&self) -> Config {
        self.config.read().map(|c| c.clone()).unwrap_or_default()
    }

    /// Gate for the whole dashboard: the setup screen owns the window until a
    /// username exists (or mock mode is explicitly on).
    pub fn configured(&self) -> bool {
        self.config_snapshot().configured(self.mock)
    }

    pub fn next_log_id(&self) -> u64 {
        self.log_seq.fetch_add(1, Ordering::Relaxed)
    }

    pub fn next_song_id(&self) -> String {
        let n = self.song_seq.fetch_add(1, Ordering::Relaxed);
        format!("s{}-{n}", now_ms())
    }

    /// Fan a payload out to every overlay and keep the session counters in
    /// sync, exactly where every event path goes through.
    pub fn broadcast(&self, mut payload: Value) {
        let kind = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.track_stats(&payload);

        let logged = matches!(kind.as_str(), "chat" | "emote" | "gift");
        if logged {
            payload["logId"] = json!(self.next_log_id());
        }
        if logged {
            self.live_log.write(
                "broadcast",
                json!({
                    "logId": payload.get("logId"),
                    "type": kind,
                    "user": payload.get("user"),
                    "nickname": payload.get("nickname"),
                    "comment": payload.get("comment"),
                    "giftName": payload.get("giftName"),
                    "emoteCount": payload.get("emoteImages").and_then(Value::as_array).map(Vec::len),
                }),
            );
        }
        if matches!(kind.as_str(), "chat" | "emote" | "gift" | "member" | "follow") {
            self.broadcast_stats();
        }
        let _ = self.tx.send(payload.to_string());
    }

    /// Internal send that never touches stats. Used for state syncs.
    pub fn send_raw(&self, payload: Value) {
        let _ = self.tx.send(payload.to_string());
    }

    fn track_stats(&self, message: &Value) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        let user = message.get("user").and_then(Value::as_str).unwrap_or("");
        let nickname = message.get("nickname").and_then(Value::as_str).unwrap_or("");
        let mut stats = match self.stats.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        match kind {
            "chat" | "emote" => {
                stats.comments += 1;
                if !user.is_empty() {
                    stats.viewers.insert(user.to_string());
                }
            }
            "gift" => {
                let repeat = message
                    .get("repeatCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .max(1);
                let diamonds = message
                    .get("diamondCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                stats.gifts += repeat;
                stats.gift_diamonds += diamonds;
                if !user.is_empty() {
                    let gifter = stats
                        .gifters
                        .entry(user.to_string())
                        .or_insert_with(|| Gifter { nickname: nickname.into(), diamonds: 0 });
                    gifter.nickname = nickname.into();
                    gifter.diamonds += diamonds;
                }
            }
            "member" => {
                if !user.is_empty() {
                    stats.viewers.insert(user.to_string());
                }
            }
            _ => {}
        }
    }

    pub fn stats_snapshot(&self) -> (u64, u64, u64, usize, Option<(String, u64)>) {
        let stats = match self.stats.lock() {
            Ok(s) => s,
            Err(_) => return (0, 0, 0, 0, None),
        };
        let top = stats
            .gifters
            .values()
            .max_by_key(|g| g.diamonds)
            .map(|g| (g.nickname.clone(), g.diamonds));
        (
            stats.comments,
            stats.gifts,
            stats.gift_diamonds,
            stats.viewers.len(),
            top,
        )
    }

    pub fn stats_payload(&self) -> Value {
        let (comments, gifts, diamonds, viewers, _) = self.stats_snapshot();
        json!({
            "type": "stats-state",
            "comments": comments,
            "gifts": gifts,
            "giftDiamonds": diamonds,
            "viewers": viewers,
        })
    }

    pub fn summary_payload(&self) -> Value {
        let (comments, gifts, diamonds, viewers, top) = self.stats_snapshot();
        json!({
            "type": "summary",
            "comments": comments,
            "gifts": gifts,
            "giftDiamonds": diamonds,
            "viewers": viewers,
            "topGifter": top.map(|(nickname, diamonds)| json!({
                "nickname": nickname,
                "diamonds": diamonds,
            })),
        })
    }

    pub fn broadcast_stats(&self) {
        let payload = self.stats_payload();
        let _ = self.tx.send(payload.to_string());
    }

    pub fn connection_payload(&self) -> Value {
        let conn = match self.conn.read() {
            Ok(c) => c.clone(),
            Err(_) => Conn::default(),
        };
        json!({
            "type": "tiktok-connection-state",
            "connected": conn.status == ConnStatus::Live,
            "state": conn.status.as_str(),
            "detail": conn.detail,
            "attempts": conn.attempts,
            "username": conn.username,
            "roomId": conn.room_id,
        })
    }

    pub fn set_conn(&self, status: ConnStatus, detail: impl Into<String>, attempts: u32) {
        if let Ok(mut conn) = self.conn.write() {
            conn.status = status;
            conn.detail = detail.into();
            conn.attempts = attempts;
            if status != ConnStatus::Live {
                conn.room_id = None;
            }
            conn.username = self.config_snapshot().username_clean();
        }
        let payload = self.connection_payload();
        let _ = self.tx.send(payload.to_string());
    }

    pub fn set_conn_live(&self, room_id: &str) {
        if let Ok(mut conn) = self.conn.write() {
            conn.status = ConnStatus::Live;
            conn.detail = String::new();
            conn.attempts = 0;
            conn.room_id = Some(room_id.to_string());
            conn.username = self.config_snapshot().username_clean();
        }
        let payload = self.connection_payload();
        let _ = self.tx.send(payload.to_string());
        self.live_log.write(
            "tiktok-state",
            json!({ "event": "connected", "roomId": room_id }),
        );
    }

    pub fn timer_payload(&self) -> Value {
        let timer = match self.timer.lock() {
            Ok(t) => t,
            Err(_) => return json!({ "type": "timer-state", "status": "idle" }),
        };
        json!({
            "type": "timer-state",
            "status": timer.status,
            "durationMs": timer.duration_ms,
            "endsAt": timer.ends_at,
            "remainingMs": timer.remaining_ms,
            "message": timer.message,
        })
    }

    pub fn tts_payloads(&self) -> Vec<Value> {
        let tts = match self.tts.lock() {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        vec![
            json!({ "type": "tts-provider-state", "provider": tts.provider }),
            json!({ "type": "tts-lang-state", "lang": tts.lang }),
            json!({ "type": "tts-enabled-state", "enabled": tts.enabled }),
            json!({ "type": "tts-speed-state", "speed": tts.speed }),
            json!({ "type": "tts-read-chance-state", "chance": tts.read_chance }),
        ]
    }

    pub fn sync_payloads(&self) -> Vec<Value> {
        let mut payloads = vec![self.timer_payload(), self.connection_payload()];
        payloads.extend(self.tts_payloads());
        payloads.push(crate::songs::song_state_payload(self));
        payloads
    }
}

pub fn load_fillers(path: &PathBuf) -> Vec<Song> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str::<Vec<Song>>(&raw).unwrap_or_default()
}

pub fn save_fillers(path: &PathBuf, fillers: &[Song]) {
    if let Ok(json) = serde_json::to_string_pretty(fillers) {
        if let Err(err) = std::fs::write(path, format!("{json}\n")) {
            tracing::warn!("could not save filler songs: {err}");
        }
    }
}
