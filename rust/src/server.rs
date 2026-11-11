use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

use crate::config::{self, Config};
use crate::easydonate;
use crate::songs;
use crate::state::{now_ms, AppState};
use crate::tiktok;
use crate::tts;

#[derive(RustEmbed)]
#[folder = "web/"]
struct WebAssets;

#[derive(RustEmbed)]
#[folder = "../widgets/"]
struct WidgetAssets;

#[derive(RustEmbed)]
#[folder = "../fonts/"]
struct FontAssets;

pub async fn run(state: Arc<AppState>, std_listener: std::net::TcpListener) {
    let listener = match TcpListener::from_std(std_listener) {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("could not start listener: {err}");
            return;
        }
    };
    spawn_timer(state.clone());
    tiktok::restart(state.clone());
    if state.mock {
        spawn_mock(state.clone());
    }

    let app = Router::new()
        .route("/", get(index))
        .route("/setup", get(index))
        .route("/chat", get(page_chat))
        .route("/pinned", get(page_pinned))
        .route("/panel", get(page_panel))
        .route("/top-donate", get(page_top_donate))
        .route("/summary", get(page_summary))
        .route("/timer", get(page_timer))
        .route("/music", get(page_music))
        .route("/follow", get(page_follow))
        .route("/chatbox", get(page_chatbox))
        .route("/widgets/{*path}", get(widget_asset))
        .route("/fonts/{*path}", get(font_asset))
        .route("/assets/{*path}", get(web_asset))
        .route("/vendor/confetti.js", get(confetti))
        .route("/tts", get(tts_route))
        .route("/ws", get(ws_handler))
        .route("/api/health", get(health))
        .route("/api/state", get(api_state))
        .route("/api/config", post(api_config))
        .route("/api/reconnect", post(api_reconnect))
        .route("/api/leaderboard", get(api_leaderboard))
        .route("/api/open-window", post(api_open_window))
        .route("/api/tiktok-live/status", get(api_tiktok_live_status))
        .route("/api/tiktok-live/create", post(api_tiktok_live_create))
        .route("/api/tiktok-live/end", post(api_tiktok_live_end))
        .fallback(not_found)
        .with_state(state);

    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("stopping");
        std::process::exit(0);
    });

    if let Err(err) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        tracing::error!("server stopped: {err}");
    }
}

fn no_store() -> [(header::HeaderName, &'static str); 1] {
    [(header::CACHE_CONTROL, "no-store")]
}

async fn index() -> Response {
    match WebAssets::get("index.html") {
        Some(file) => (
            no_store(),
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            file.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::INTERNAL_SERVER_ERROR, "index.html missing").into_response(),
    }
}

fn widget_page(path: &str) -> Response {
    match WidgetAssets::get(path) {
        Some(file) => (
            no_store(),
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            file.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Widget page missing").into_response(),
    }
}

async fn page_chat() -> Response {
    widget_page("chat/chat.html")
}
async fn page_pinned() -> Response {
    widget_page("pinned/pinned.html")
}
async fn page_panel() -> Response {
    widget_page("panel/panel.html")
}
async fn page_top_donate() -> Response {
    widget_page("top-donate/top-donate.html")
}
async fn page_summary() -> Response {
    widget_page("summary/summary.html")
}
async fn page_timer() -> Response {
    widget_page("timer/timer.html")
}
async fn page_music() -> Response {
    widget_page("music/music.html")
}
async fn page_follow() -> Response {
    widget_page("follow/follow.html")
}
async fn page_chatbox() -> Response {
    widget_page("chatbox/chatbox.html")
}

fn embedded(folder: &str, path: &str, data: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if folder == "fonts" {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    };
    (
        [(header::CONTENT_TYPE, mime.as_ref().to_string())],
        [(header::CACHE_CONTROL, cache.to_string())],
        data,
    )
        .into_response()
}

async fn widget_asset(Path(path): Path<String>) -> Response {
    let clean = sanitize(&path);
    match WidgetAssets::get(&clean) {
        Some(file) => embedded("widgets", &clean, file.data.into_owned()),
        None => (StatusCode::NOT_FOUND, "Widget file not found").into_response(),
    }
}

async fn font_asset(Path(path): Path<String>) -> Response {
    let clean = sanitize(&path);
    match FontAssets::get(&clean) {
        Some(file) => embedded("fonts", &clean, file.data.into_owned()),
        None => (StatusCode::NOT_FOUND, "Font not found").into_response(),
    }
}

async fn web_asset(Path(path): Path<String>) -> Response {
    let clean = sanitize(&path);
    match WebAssets::get(&clean) {
        Some(file) => embedded("web", &clean, file.data.into_owned()),
        None => (StatusCode::NOT_FOUND, "Asset not found").into_response(),
    }
}

async fn confetti() -> Response {
    match WebAssets::get("vendor/confetti.js") {
        Some(file) => (
            [(header::CONTENT_TYPE, "application/javascript")],
            file.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "confetti.js missing").into_response(),
    }
}

fn sanitize(path: &str) -> String {
    path.split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/")
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "app": "tiktok-live-reader",
        "version": crate::state::APP_VERSION,
        "mock": state.mock,
    }))
}

async fn api_state(State(state): State<Arc<AppState>>) -> Json<Value> {
    let config = state.config_snapshot();
    let tts = state.tts.lock().map(|t| {
        json!({
            "provider": t.provider,
            "lang": t.lang,
            "enabled": t.enabled,
            "speed": t.speed,
            "readChance": t.read_chance,
        })
    }).unwrap_or(Value::Null);
    Json(json!({
        "configured": state.configured(),
        "mock": state.mock,
        "version": crate::state::APP_VERSION,
        "port": state.port,
        "config": config,
        "connection": state.connection_payload(),
        "timer": state.timer_payload(),
        "song": songs::song_state_payload(&state),
        "tts": tts,
    }))
}

async fn api_config(
    State(state): State<Arc<AppState>>,
    Json(mut incoming): Json<Config>,
) -> Response {
    incoming.tiktok_username = config::normalize_username(&incoming.tiktok_username);
    if incoming.song_max_duration_sec == 0 {
        incoming.song_max_duration_sec = 600;
    }
    if incoming.youtube_region.trim().is_empty() {
        incoming.youtube_region = "ID".into();
    }
    if incoming.easydonate_api_base_url.trim().is_empty() {
        incoming.easydonate_api_base_url = "https://api.easydonate.app".into();
    }
    if incoming.tts_engine_url.trim().is_empty() {
        incoming.tts_engine_url = "http://127.0.0.1:8000/v1/tts".into();
    }

    if let Err(err) = config::save(&state.config_path, &incoming) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": format!("Could not save config: {err}") })),
        )
            .into_response();
    }
    if let Ok(mut current) = state.config.write() {
        *current = incoming.clone();
    }
    if let Ok(mut songs) = state.songs.lock() {
        let has_key = !incoming.youtube_api_key.trim().is_empty();
        songs.enabled = has_key;
    }
    tiktok::restart(state.clone());
    state.send_raw(songs::song_state_payload(&state));
    state.send_raw(state.connection_payload());
    Json(json!({
        "ok": true,
        "configured": state.configured(),
        "config": incoming,
    }))
    .into_response()
}

async fn api_reconnect(State(state): State<Arc<AppState>>) -> Json<Value> {
    tiktok::restart(state.clone());
    Json(json!({ "ok": true }))
}

async fn api_leaderboard(State(state): State<Arc<AppState>>) -> Response {
    match easydonate::leaderboard(&state).await {
        Ok((leaderboard, mock)) => Json(json!({ "leaderboard": leaderboard, "mock": mock })).into_response(),
        Err(err) => {
            tracing::warn!("EasyDonate leaderboard error: {err}");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "EasyDonate request failed" })),
            )
                .into_response()
        }
    }
}

async fn tts_route(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let text = params.get("text").cloned().unwrap_or_default();
    if text.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing text param").into_response();
    }
    let (provider, lang) = state
        .tts
        .lock()
        .map(|t| (t.provider.clone(), t.lang.clone()))
        .unwrap_or_else(|_| ("google".into(), "en".into()));
    let result = if provider == "local" {
        tts::local(&state, &text, &lang).await
    } else {
        tts::google(&state, &text, &lang).await
    };
    match result {
        Ok((bytes, content_type)) => (
            [(header::CONTENT_TYPE, content_type)],
            [(header::CACHE_CONTROL, "no-store")],
            bytes,
        )
            .into_response(),
        Err(err) => {
            tracing::warn!("{err}");
            (StatusCode::BAD_GATEWAY, "TTS proxy failed").into_response()
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_session(socket, state))
}

async fn ws_session(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    for payload in state.sync_payloads() {
        if sender
            .send(Message::Text(payload.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => handle_ws_message(&state, text.as_str()),
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
            broadcast = rx.recv() => {
                match broadcast {
                    Ok(text) => {
                        if sender.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

fn handle_ws_message(state: &Arc<AppState>, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else { return };
    let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "overlay-log" => {
            let mut report = message.clone();
            if let Some(object) = report.as_object_mut() {
                object.remove("type");
            }
            state.live_log.write("overlay", report);
        }
        "pin" | "unpin" => state.broadcast(message),
        "show-summary" => state.send_raw(state.summary_payload()),
        "timer-start" => {
            let duration = message
                .get("durationMs")
                .and_then(Value::as_i64)
                .unwrap_or(300_000)
                .max(1000);
            if let Ok(mut timer) = state.timer.lock() {
                timer.duration_ms = duration;
                timer.ends_at = Some(now_ms() + duration);
                timer.remaining_ms = None;
                timer.status = "running".into();
            }
            state.send_raw(state.timer_payload());
        }
        "timer-pause" => {
            let mut changed = false;
            if let Ok(mut timer) = state.timer.lock() {
                if timer.status == "running" {
                    if let Some(ends_at) = timer.ends_at {
                        timer.remaining_ms = Some((ends_at - now_ms()).max(0));
                    }
                    timer.ends_at = None;
                    timer.status = "paused".into();
                    changed = true;
                }
            }
            if changed {
                state.send_raw(state.timer_payload());
            }
        }
        "timer-resume" => {
            let mut changed = false;
            if let Ok(mut timer) = state.timer.lock() {
                if timer.status == "paused" {
                    timer.ends_at = Some(now_ms() + timer.remaining_ms.unwrap_or(0));
                    timer.remaining_ms = None;
                    timer.status = "running".into();
                    changed = true;
                }
            }
            if changed {
                state.send_raw(state.timer_payload());
            }
        }
        "timer-reset" => {
            if let Ok(mut timer) = state.timer.lock() {
                timer.status = "idle".into();
                timer.ends_at = None;
                timer.remaining_ms = None;
            }
            state.send_raw(state.timer_payload());
        }
        "timer-set-message" => {
            if let Some(text) = message.get("message").and_then(Value::as_str) {
                if let Ok(mut timer) = state.timer.lock() {
                    timer.message = text.to_string();
                }
                state.send_raw(state.timer_payload());
            }
        }
        "set-song-enabled" => {
            let enabled = message.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            if let Ok(mut songs) = state.songs.lock() {
                songs.enabled = enabled;
                if !enabled {
                    songs.pending.clear();
                    songs.approved.clear();
                }
            }
            state.send_raw(songs::song_state_payload(state));
        }
        "set-song-auto-approve" => {
            let enabled = message.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            let mut start = false;
            if let Ok(mut songs) = state.songs.lock() {
                songs.auto_approve = enabled;
                if enabled && !songs.pending.is_empty() {
                    let pending = std::mem::take(&mut songs.pending);
                    songs.approved.extend(pending);
                    start = songs.now_playing.is_none();
                }
            }
            if start {
                songs::advance_song(state);
            } else {
                state.send_raw(songs::song_state_payload(state));
            }
        }
        "song-approve" => {
            let id = message.get("id").and_then(Value::as_str).unwrap_or("");
            let mut start = false;
            if let Ok(mut songs) = state.songs.lock() {
                if let Some(index) = songs.pending.iter().position(|song| song.id == id) {
                    let song = songs.pending.remove(index);
                    songs.approved.push(song);
                    start = songs.now_playing.is_none();
                }
            }
            if start {
                songs::advance_song(state);
            } else {
                state.send_raw(songs::song_state_payload(state));
            }
        }
        "song-reject" => {
            let id = message.get("id").and_then(Value::as_str).unwrap_or("");
            let mut changed = false;
            if let Ok(mut songs) = state.songs.lock() {
                if let Some(index) = songs.pending.iter().position(|song| song.id == id) {
                    songs.pending.remove(index);
                    changed = true;
                } else if let Some(index) = songs.approved.iter().position(|song| song.id == id) {
                    songs.approved.remove(index);
                    changed = true;
                }
            }
            if changed {
                state.send_raw(songs::song_state_payload(state));
            }
        }
        "song-start" => {
            let idle = state
                .songs
                .lock()
                .map(|songs| songs.now_playing.is_none())
                .unwrap_or(false);
            if idle {
                songs::advance_song(state);
            }
        }
        "song-skip" => songs::advance_song(state),
        "song-stop" => {
            if let Ok(mut songs) = state.songs.lock() {
                songs.now_playing = None;
            }
            state.send_raw(songs::song_state_payload(state));
        }
        "song-ended" | "song-error" => {
            let id = message.get("id").and_then(Value::as_str).unwrap_or("");
            let matches_current = state
                .songs
                .lock()
                .map(|songs| {
                    songs
                        .now_playing
                        .as_ref()
                        .map(|song| song.id == id)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if matches_current {
                if kind == "song-error" {
                    tracing::warn!("[song] player error, skipping");
                }
                songs::advance_song(state);
            }
        }
        "filler-add" => {
            let link = message
                .get("link")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let state = state.clone();
            tokio::spawn(async move {
                if let Err(reason) = songs::add_filler_song(state.clone(), link).await {
                    state.send_raw(json!({ "type": "filler-add-failed", "reason": reason }));
                }
            });
        }
        "filler-remove" => {
            let id = message.get("id").and_then(Value::as_str).unwrap_or("");
            songs::remove_filler(state, id);
        }
        "set-tts-provider" => {
            let provider = message.get("provider").and_then(Value::as_str).unwrap_or("");
            if provider != "local" && provider != "google" {
                return;
            }
            if let Ok(mut tts) = state.tts.lock() {
                tts.provider = provider.into();
            }
            state.send_raw(json!({ "type": "tts-provider-state", "provider": provider }));
        }
        "set-tts-lang" => {
            let lang = message
                .get("lang")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if !matches!(lang.as_str(), "en" | "id" | "th") {
                return;
            }
            if let Ok(mut tts) = state.tts.lock() {
                tts.lang = lang.clone();
            }
            state.send_raw(json!({ "type": "tts-lang-state", "lang": lang }));
        }
        "set-tts-enabled" => {
            let enabled = message.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            if let Ok(mut tts) = state.tts.lock() {
                tts.enabled = enabled;
            }
            state.send_raw(json!({ "type": "tts-enabled-state", "enabled": enabled }));
        }
        "set-tts-speed" => {
            let speed = message.get("speed").and_then(Value::as_f64).unwrap_or(1.5);
            if !(0.5..=3.0).contains(&speed) {
                return;
            }
            if let Ok(mut tts) = state.tts.lock() {
                tts.speed = speed;
            }
            state.send_raw(json!({ "type": "tts-speed-state", "speed": speed }));
        }
        "set-tts-read-chance" => {
            let chance = message.get("chance").and_then(Value::as_f64).unwrap_or(1.0);
            if !(0.0..=1.0).contains(&chance) {
                return;
            }
            if let Ok(mut tts) = state.tts.lock() {
                tts.read_chance = chance;
            }
            state.send_raw(json!({ "type": "tts-read-chance-state", "chance": chance }));
        }
        _ => {}
    }
}

fn spawn_timer(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let ended = {
                let Ok(mut timer) = state.timer.lock() else { continue };
                if timer.status == "running" && timer.ends_at.map(|end| now_ms() >= end).unwrap_or(false) {
                    timer.status = "ended".into();
                    timer.ends_at = None;
                    true
                } else {
                    false
                }
            };
            if ended {
                state.send_raw(state.timer_payload());
            }
        }
    });
}

fn spawn_mock(state: Arc<AppState>) {
    let users = [
        "nampeung_99",
        "kai_gamer",
        "pim.streamfan",
        "tanawat_th",
        "user_888",
        "miko.chan",
        "🐱miko🐱",
        "👨‍👩‍👧 family",
        "🇮🇩 friends",
        "👍🏽ok",
        "❤️love",
    ];
    let comments = [
        "hi hi, been here since the start",
        "video quality looks great today",
        "what time does the stream end?",
        "you are so good at this",
        "the audio is a bit quiet for me",
        "drop the setup specs please",
        "been watching every day this week",
        "nice nice nice",
        "can you play something chill next?",
        "hello from Indonesia!",
        "5555555555",
        "good good good good good",
        "very niceeeeeeee",
        "playing around",
    ];
    let gifts = [
        ("Rose", "https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png"),
        ("Ice Cream Cone", "https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png"),
        ("Glow Stick", ""),
    ];
    let avatar = |name: &str| format!("https://i.pravatar.cc/150?u={}", urlencoding(name));

    if state.mock_chat {
        let state_chat = state.clone();
        let users = users;
        let comments = comments;
        tokio::spawn(async move {
            let mut index = 0_usize;
            loop {
                tokio::time::sleep(Duration::from_millis(2500)).await;
                let nickname = users[index % users.len()];
                let comment = comments[index % comments.len()];
                index += 1;
                state_chat.broadcast(json!({
                    "type": "chat",
                    "user": nickname,
                    "nickname": nickname,
                    "avatarUrl": avatar(nickname),
                    "comment": comment,
                }));
            }
        });

        let state_gift = state.clone();
        tokio::spawn(async move {
            let mut index = 0_usize;
            loop {
                tokio::time::sleep(Duration::from_secs(8)).await;
                let nickname = users[index % users.len()];
                let (gift_name, gift_image) = gifts[index % gifts.len()];
                index += 1;
                state_gift.broadcast(json!({
                    "type": "gift",
                    "user": nickname,
                    "nickname": nickname,
                    "avatarUrl": avatar(nickname),
                    "giftName": gift_name,
                    "giftImage": gift_image,
                    "repeatCount": (index % 5) + 1,
                    "diamondCount": ((index % 5) + 1) * 5,
                }));
            }
        });

        let state_member = state.clone();
        tokio::spawn(async move {
            let mut index = 0_usize;
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let nickname = users[index % users.len()];
                index += 1;
                state_member.broadcast(json!({
                    "type": "member",
                    "user": nickname,
                    "nickname": nickname,
                    "avatarUrl": avatar(nickname),
                }));
            }
        });
    }

    tokio::spawn(async move {
        let mut index = 0_usize;
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let nickname = users[index % users.len()];
            index += 1;
            state.broadcast(json!({
                "type": "follow",
                "user": nickname,
                "nickname": nickname,
                "avatarUrl": avatar(nickname),
            }));
        }
    });
}

fn urlencoding(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn api_open_window(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<Value>,
) -> Response {
    if !addr.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "Loopback only").into_response();
    }
    let view = body
        .get("view")
        .and_then(Value::as_str)
        .unwrap_or("chatbox");
    if !matches!(view, "chatbox" | "panel" | "control") {
        return (StatusCode::BAD_REQUEST, "Unknown view").into_response();
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response()
        }
    };
    match std::process::Command::new(exe)
        .arg("--view")
        .arg(view)
        .arg("--port")
        .arg(state.port.to_string())
        .spawn()
    {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn api_tiktok_live_status(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let config = state.config_snapshot();
    let script = params
        .get("script")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(config.tiktok_live_script);
    let path = PathBuf::from(&script);
    Json(json!({
        "available": !script.trim().is_empty() && path.exists(),
        "path": script,
        "python": which("python3").is_some(),
    }))
}

async fn api_tiktok_live_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    run_tiktok_live(state, body, "create").await
}

async fn api_tiktok_live_end(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    run_tiktok_live(state, body, "end").await
}

async fn run_tiktok_live(state: Arc<AppState>, body: Value, action: &str) -> Response {
    let config = state.config_snapshot();
    let script = body
        .get("scriptPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&config.tiktok_live_script)
        .to_string();
    if script.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "Set the tiktok_live.py script path first" })),
        )
            .into_response();
    }
    if !FsPath::new(&script).exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": format!("Script not found: {script}") })),
        )
            .into_response();
    }
    let cookies = body
        .get("cookiesPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            FsPath::new(&script)
                .parent()
                .unwrap_or_else(|| FsPath::new("."))
                .join("www.tiktok.com.cookies.json")
                .to_string_lossy()
                .to_string()
        });

    let mut command = tokio::process::Command::new("python3");
    command.arg(&script).arg(action).arg("--cookies").arg(&cookies);
    if action == "create" {
        for (field, flag) in [
            ("title", "--title"),
            ("topic", "--topic"),
            ("region", "--region"),
            ("timezone", "--timezone"),
            ("output", "--output"),
        ] {
            if let Some(value) = body.get(field).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    command.arg(flag).arg(value);
                }
            }
        }
        if body.get("replay").and_then(Value::as_bool).unwrap_or(false) {
            command.arg("--replay");
        }
        if body
            .get("ageRestricted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            command.arg("--age-restricted");
        }
    }
    command.kill_on_drop(true);

    let output = match tokio::time::timeout(Duration::from_secs(120), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response()
        }
        Err(_) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "ok": false, "error": "tiktok_live.py timed out" })),
            )
                .into_response()
        }
    };
    let result = json!({
        "ok": output.status.success(),
        "code": output.status.code().unwrap_or(-1),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
        "scriptPath": script,
    });
    state.send_raw(json!({ "type": "tiktok-live-result", "action": action, "result": result }));
    Json(result).into_response()
}

fn which(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}

/// Used by the window launcher to decide whether a server is already running.
pub fn server_is_up(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

pub fn bind(port: u16) -> std::io::Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}
