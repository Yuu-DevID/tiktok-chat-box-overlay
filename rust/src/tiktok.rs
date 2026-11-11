use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tiktok_live_connector::web::CookieSession;
use tiktok_live_connector::proto::{
    User, WebcastChatMessage, WebcastEmoteChatMessage, WebcastGiftMessage, WebcastMemberMessage,
    WebcastSocialMessage,
};
use tiktok_live_connector::{ConnectionOptions, Event, TikTokLiveConnection};

use crate::profanity::is_profane_comment;
use crate::songs::handle_song_request_comment;
use crate::state::{AppState, ConnStatus};

/// Restart the TikTok reader with the current config. The old task is aborted
/// first so a username change takes effect immediately.
pub fn restart(state: Arc<AppState>) {
    let task_state = state.clone();
    if let Ok(mut slot) = state.tiktok_task.lock() {
        if let Some(task) = slot.take() {
            task.abort();
        }
        *slot = Some(tokio::spawn(run(task_state)));
    }
}

async fn run(state: Arc<AppState>) {
    if state.mock {
        state.set_conn_live("mock");
        return;
    }

    let mut attempts: u32 = 0;
    loop {
        let config = state.config_snapshot();
        let username = config.username_clean();
        if username.is_empty() {
            state.set_conn(ConnStatus::Offline, "Enter your TikTok username in Setup.", 0);
            return;
        }

        attempts += 1;
        state.set_conn(
            ConnStatus::Connecting,
            format!("Connecting to @{username}, attempt {attempts}."),
            attempts,
        );

        let options = ConnectionOptions {
            sign_api_key: (!config.sign_api_key.trim().is_empty())
                .then(|| config.sign_api_key.trim().to_string()),
            session: if !config.session_id.trim().is_empty()
                && !config.tt_target_idc.trim().is_empty()
            {
                Some(CookieSession::new(
                    config.session_id.trim(),
                    config.tt_target_idc.trim(),
                ))
            } else {
                None
            },
            ..Default::default()
        };

        let connection = match TikTokLiveConnection::with_options(&username, options) {
            Ok(connection) => connection,
            Err(err) => {
                state.set_conn(
                    ConnStatus::Error,
                    format!("That username is not valid: {err}"),
                    attempts,
                );
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };
        let mut events = connection.subscribe();

        match connection.connect().await {
            Ok(room) => {
                attempts = 0;
                tracing::info!("connected to TikTok room {} (@{username})", room.room_id);
                state.set_conn_live(&room.room_id);
            }
            Err(err) => {
                let message = friendly_connect_error(&err.to_string(), &username);
                tracing::warn!("TikTok connect failed (@{username}): {err}");
                state.live_log.write(
                    "tiktok-state",
                    json!({ "event": "connect-failed", "error": err.to_string() }),
                );
                state.set_conn(ConnStatus::Error, message, attempts);
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        }

        loop {
            let event = match events.recv().await {
                Some(event) => event,
                None => break,
            };
            match event {
                Event::Chat(message) => on_chat(&state, &message),
                Event::Emote(message) => on_emote(&state, &message),
                Event::Gift(message) => on_gift(&state, &message),
                Event::Member(message) => on_member(&state, &message),
                Event::Follow(message) => on_follow(&state, &message),
                Event::StreamEnd(_) => {
                    tracing::info!("TikTok stream ended");
                    state.live_log.write("tiktok-state", json!({ "event": "stream-end" }));
                    break;
                }
                Event::Disconnected(info) => {
                    tracing::info!("TikTok socket closed: {} {}", info.code, info.reason);
                    break;
                }
                Event::Error(error) => {
                    tracing::warn!("TikTok connector error: {error}");
                    state.live_log.write(
                        "error",
                        json!({ "where": "connector", "info": error.info, "error": error.exception.to_string() }),
                    );
                }
                _ => {}
            }
        }

        let _ = connection.disconnect().await;
        state.set_conn(
            ConnStatus::Connecting,
            format!("Connection dropped. Reconnecting to @{username}."),
            attempts,
        );
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

fn friendly_connect_error(raw: &str, username: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("offline") || lower.contains("not live") || lower.contains("room") {
        format!("@{username} is not live right now. Start the LIVE on TikTok, then reconnect.")
    } else if lower.contains("sign") || lower.contains("429") || lower.contains("quota") {
        "The sign server refused the connection. Add a sign API key in Setup, or try again in a minute."
            .to_string()
    } else if lower.contains("not found") || lower.contains("404") || lower.contains("user") {
        format!("Can't find @{username}. Check the spelling in Setup.")
    } else {
        format!("Could not connect to @{username}. Check that the account is live. ({raw})")
    }
}

fn user_fields(user: Option<&User>) -> (String, String, String) {
    let Some(user) = user else {
        return (String::new(), String::new(), String::new());
    };
    let avatar = user
        .avatar_thumb
        .as_ref()
        .and_then(|image| image.url_list.first())
        .cloned()
        .unwrap_or_default();
    (user.display_id.clone(), user.nickname.clone(), avatar)
}

fn on_chat(state: &Arc<AppState>, message: &WebcastChatMessage) {
    let (user, nickname, avatar) = user_fields(message.user.as_ref());
    if nickname.is_empty() && user.is_empty() {
        return;
    }
    if is_profane_comment(&message.content) {
        state.live_log.write(
            "filtered",
            json!({ "reason": "profanity", "user": user, "content": message.content }),
        );
        tracing::info!("[filtered] {nickname}: {}", message.content);
        return;
    }

    state.broadcast(json!({
        "type": "chat",
        "user": user,
        "nickname": nickname,
        "avatarUrl": avatar,
        "comment": message.content,
    }));
    tracing::info!("{nickname}: {}", message.content);

    let state = state.clone();
    let user_for_song = user.clone();
    let nickname_for_song = nickname.clone();
    let content = message.content.clone();
    // Song lookup must never delay the chat overlay.
    tokio::spawn(async move {
        handle_song_request_comment(state, user_for_song, nickname_for_song, content).await;
    });
}

fn on_emote(state: &Arc<AppState>, message: &WebcastEmoteChatMessage) {
    let (user, nickname, avatar) = user_fields(message.user.as_ref());
    let images: Vec<String> = message
        .emote_list
        .iter()
        .filter_map(|emote| emote.image.as_ref())
        .filter_map(|image| image.url_list.first().cloned())
        .collect();
    if images.is_empty() {
        return;
    }
    state.broadcast(json!({
        "type": "emote",
        "user": user,
        "nickname": nickname,
        "avatarUrl": avatar,
        "emoteImages": images,
    }));
}

fn on_gift(state: &Arc<AppState>, message: &WebcastGiftMessage) {
    let gift = message.gift.as_ref();
    let streakable = gift.map(|g| g.r#type == 1).unwrap_or(false);
    if streakable && message.repeat_end != 1 {
        return;
    }

    let (user, nickname, avatar) = user_fields(message.user.as_ref());
    let gift_name = gift
        .map(|g| g.name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Gift".to_string());
    let gift_image = gift
        .and_then(|g| g.image.as_ref())
        .and_then(|image| image.url_list.first())
        .cloned()
        .unwrap_or_default();
    let repeat = message.repeat_count.max(1) as u64;
    let diamonds = gift.map(|g| g.diamond_count.max(0) as u64).unwrap_or(0) * repeat;

    state.broadcast(json!({
        "type": "gift",
        "user": user,
        "nickname": nickname,
        "avatarUrl": avatar,
        "giftName": gift_name,
        "giftImage": gift_image,
        "repeatCount": repeat,
        "diamondCount": diamonds,
    }));
    tracing::info!("{nickname} sent {gift_name} x{repeat}");
}

fn on_member(state: &Arc<AppState>, message: &WebcastMemberMessage) {
    let (user, nickname, avatar) = user_fields(message.user.as_ref());
    if nickname.is_empty() {
        return;
    }
    state.broadcast(json!({
        "type": "member",
        "user": user,
        "nickname": nickname,
        "avatarUrl": avatar,
    }));
}

fn on_follow(state: &Arc<AppState>, message: &WebcastSocialMessage) {
    let (user, nickname, avatar) = user_fields(message.user.as_ref());
    if nickname.is_empty() {
        return;
    }
    state.broadcast(json!({
        "type": "follow",
        "user": user,
        "nickname": nickname,
        "avatarUrl": avatar,
    }));
}
