use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::Duration;

use crate::state::{now_ms, save_fillers, AppState, Song, Songs};

const RECENT_VIDEO_MEMORY: usize = 20;
const SEARCH_CANDIDATES: usize = 8;
const QUERY_MAX_LENGTH: usize = 120;

static SONG_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(?:m!p|/music)(?:\s+|$)").unwrap());
static VIDEO_LINK_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"(?i)youtube\.com/watch\?(?:[^\s]*&)?v=([A-Za-z0-9_-]{11})").unwrap(),
        Regex::new(r"(?i)youtu\.be/([A-Za-z0-9_-]{11})").unwrap(),
        Regex::new(r"(?i)youtube\.com/shorts/([A-Za-z0-9_-]{11})").unwrap(),
        Regex::new(r"(?i)youtube\.com/live/([A-Za-z0-9_-]{11})").unwrap(),
        Regex::new(r"(?i)youtube\.com/embed/([A-Za-z0-9_-]{11})").unwrap(),
    ]
});
static ISO_DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$").unwrap());
static YT_INITIAL_DATA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:var\s+)?ytInitialData\s*=").unwrap());

const YOUTUBE_SEARCH_UA: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

pub fn parse_song_command(text: &str) -> Option<String> {
    let matched = SONG_COMMAND.find(text)?;
    Some(text[matched.end()..].trim().to_string())
}

pub fn extract_video_id(text: &str) -> Option<String> {
    VIDEO_LINK_PATTERNS
        .iter()
        .find_map(|pattern| pattern.captures(text).map(|c| c[1].to_string()))
}

pub fn parse_iso_duration(iso: &str) -> Option<u64> {
    let captures = ISO_DURATION.captures(iso)?;
    let value = |index: usize| -> u64 {
        captures
            .get(index)
            .and_then(|m| m.as_str().parse::<u64>().ok())
            .unwrap_or(0)
    };
    Some(value(1) * 86400 + value(2) * 3600 + value(3) * 60 + value(4))
}

fn is_live_result(renderer: &Value) -> bool {
    renderer
        .get("badges")
        .and_then(Value::as_array)
        .map(|badges| {
            badges.iter().any(|badge| {
                badge
                    .pointer("/metadataBadgeRenderer/label")
                    .and_then(Value::as_str)
                    .map(|label| label.to_uppercase().contains("LIVE"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn has_duration_label(renderer: &Value) -> bool {
    match renderer.get("lengthText") {
        Some(length) => {
            length.get("simpleText").and_then(Value::as_str).is_some()
                || length
                    .get("runs")
                    .and_then(Value::as_array)
                    .map(|runs| !runs.is_empty())
                    .unwrap_or(false)
        }
        None => false,
    }
}

fn is_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn collect_video_ids(node: &Value, out: &mut Vec<String>, allow_live: bool, depth: usize) {
    if depth > 40 || out.len() >= SEARCH_CANDIDATES {
        return;
    }
    match node {
        Value::Object(map) => {
            if let Some(renderer) = map.get("videoRenderer") {
                if let Some(id) = renderer.get("videoId").and_then(Value::as_str) {
                    let playable = allow_live || (!is_live_result(renderer) && has_duration_label(renderer));
                    if is_video_id(id) && playable && !out.iter().any(|existing| existing == id) {
                        out.push(id.to_string());
                    }
                }
            }
            if let Some(lockup) = map.get("lockupViewModel") {
                let is_video = lockup
                    .get("contentType")
                    .and_then(Value::as_str)
                    .map(|kind| kind == "LOCKUP_CONTENT_TYPE_VIDEO")
                    .unwrap_or(false);
                if is_video {
                    if let Some(id) = lockup.get("contentId").and_then(Value::as_str) {
                        if is_video_id(id) && !out.iter().any(|existing| existing == id) {
                            out.push(id.to_string());
                        }
                    }
                }
            }
            for value in map.values() {
                if out.len() >= SEARCH_CANDIDATES {
                    break;
                }
                collect_video_ids(value, out, allow_live, depth + 1);
            }
        }
        Value::Array(items) => {
            for value in items {
                if out.len() >= SEARCH_CANDIDATES {
                    break;
                }
                collect_video_ids(value, out, allow_live, depth + 1);
            }
        }
        _ => {}
    }
}

pub fn extract_video_ids_from_html(html: &str) -> Vec<String> {
    let Some(marker) = YT_INITIAL_DATA.find(html) else { return Vec::new() };
    let after = &html[marker.end()..];
    let Some(brace) = after.find('{') else { return Vec::new() };
    let blob = &after[brace..];
    let end = blob.find("</script>").unwrap_or(blob.len());
    let trimmed = blob[..end].trim().trim_end_matches(';');
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else { return Vec::new() };
    let mut recorded = Vec::new();
    collect_video_ids(&value, &mut recorded, false, 0);
    if recorded.is_empty() {
        collect_video_ids(&value, &mut recorded, true, 0);
    }
    recorded
}

/// Name search via the public results page (no Data API quota), with
/// `search.list` only as a logged fallback when YouTube changes its markup.
pub async fn search_youtube_song(state: &AppState, query: &str) -> Result<Vec<String>, String> {
    let url = format!(
        "https://www.youtube.com/results?search_query={}&hl=en&gl=US&sp=EgIQAQ%253D%253D",
        urlencoding(query)
    );
    match state
        .http
        .get(&url)
        .header("User-Agent", YOUTUBE_SEARCH_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Cookie", "CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI")
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(response) => match response.text().await {
            Ok(html) => {
                let ids = extract_video_ids_from_html(&html);
                if !ids.is_empty() {
                    tracing::info!("[song] search \"{query}\" -> {} candidate(s), first {}", ids.len(), ids[0]);
                    return Ok(ids);
                }
                tracing::warn!("[song] search page had no parseable result, falling back to Data API");
            }
            Err(err) => tracing::warn!("[song] search page body failed ({err}), falling back to Data API"),
        },
        Err(err) => tracing::warn!("[song] search page failed ({err}), falling back to Data API"),
    }

    let config = state.config_snapshot();
    if config.youtube_api_key.trim().is_empty() {
        return Err("No search result for that name".into());
    }
    let response = state
        .http
        .get("https://www.googleapis.com/youtube/v3/search")
        .query(&[
            ("part", "snippet"),
            ("type", "video"),
            ("maxResults", "5"),
            ("q", query),
            ("key", config.youtube_api_key.trim()),
        ])
        .send()
        .await
        .map_err(|err| format!("YouTube API {err}"))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("YouTube API {err}"))?;
    let ids: Vec<String> = payload
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.pointer("/id/videoId").and_then(Value::as_str))
                .filter(|id| is_video_id(id))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err("No search result for that name".into());
    }
    tracing::info!("[song] search \"{query}\" -> {} candidate(s) (Data API)", ids.len());
    Ok(ids)
}

async fn validate_video(state: &AppState, video_id: &str) -> Result<Song, String> {
    let config = state.config_snapshot();
    let response = state
        .http
        .get("https://www.googleapis.com/youtube/v3/videos")
        .query(&[
            ("part", "snippet,contentDetails,status"),
            ("id", video_id),
            ("key", config.youtube_api_key.trim()),
        ])
        .send()
        .await
        .map_err(|err| format!("YouTube API {err}"))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("YouTube API {err}"))?;
    let Some(item) = payload.get("items").and_then(|i| i.get(0)) else {
        return Err("Video not found (deleted or private)".into());
    };

    if item.pointer("/status/embeddable").and_then(Value::as_bool) == Some(false) {
        return Err("The owner disabled embedding".into());
    }
    let duration_iso = item
        .pointer("/contentDetails/duration")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(duration_sec) = parse_iso_duration(duration_iso) else {
        return Err("Could not read the video length".into());
    };
    if duration_sec == 0 {
        return Err("That is a live stream, not a video".into());
    }
    if duration_sec > config.song_max_duration_sec {
        return Err(format!(
            "Longer than {} minutes",
            (config.song_max_duration_sec as f64 / 60.0).round() as u64
        ));
    }

    if let Some(restriction) = item.pointer("/contentDetails/regionRestriction") {
        let blocked = restriction
            .get("blocked")
            .and_then(Value::as_array)
            .map(|list| list.iter().any(|v| v.as_str() == Some(config.youtube_region.as_str())))
            .unwrap_or(false);
        let allowed_only = restriction
            .get("allowed")
            .and_then(Value::as_array)
            .map(|list| !list.iter().any(|v| v.as_str() == Some(config.youtube_region.as_str())))
            .unwrap_or(false);
        if blocked || allowed_only {
            return Err(format!("Blocked in region {}", config.youtube_region));
        }
    }

    Ok(Song {
        id: String::new(),
        video_id: video_id.to_string(),
        title: item
            .pointer("/snippet/title")
            .and_then(Value::as_str)
            .unwrap_or(video_id)
            .to_string(),
        channel: item
            .pointer("/snippet/channelTitle")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        duration_sec,
        user: None,
        nickname: None,
        is_filler: false,
        requested_at: 0,
    })
}

fn is_video_taken(songs: &Songs, video_id: &str) -> bool {
    songs.pending.iter().any(|s| s.video_id == video_id)
        || songs.approved.iter().any(|s| s.video_id == video_id)
        || songs
            .now_playing
            .as_ref()
            .map(|s| s.video_id == video_id)
            .unwrap_or(false)
        || songs.recent_video_ids.iter().any(|id| id == video_id)
}

async fn resolve_request_song(state: &AppState, query: &str) -> Result<Song, String> {
    let candidates = if let Some(id) = extract_video_id(query) {
        vec![id]
    } else {
        search_youtube_song(state, query).await?
    };

    let mut last_reason = "No playable result for that name".to_string();
    for video_id in candidates {
        {
            let songs = state.songs.lock().map_err(|_| "Song queue unavailable")?;
            if is_video_taken(&songs, &video_id) {
                last_reason = "That video is already queued or just played".into();
                continue;
            }
        }
        match validate_video(state, &video_id).await {
            Ok(song) => return Ok(song),
            Err(reason) => {
                tracing::info!("[song] skipped {video_id}: {reason}");
                last_reason = reason;
            }
        }
    }
    Err(last_reason)
}

fn notify(state: &AppState, mut notice: Value) {
    notice["type"] = json!("song-request-notice");
    notice["at"] = json!(now_ms());
    state.send_raw(notice);
}

fn has_viewer_request(songs: &Songs, user: &str) -> bool {
    songs
        .pending
        .iter()
        .chain(songs.approved.iter())
        .any(|s| s.user.as_deref() == Some(user))
}

/// Called for every comment that starts with `m!p` / `/music`. Refusals are
/// only reported to the panel/chatbox: TikTok chat is read-only to us.
pub async fn handle_song_request_comment(
    state: std::sync::Arc<AppState>,
    user: String,
    nickname: String,
    comment: String,
) {
    let query = match parse_song_command(&comment) {
        Some(query) => query,
        None => return,
    };
    let config = state.config_snapshot();
    let enabled = state.songs.lock().map(|s| s.enabled).unwrap_or(false);
    if !enabled || config.youtube_api_key.trim().is_empty() {
        return;
    }

    if query.is_empty() {
        notify(
            &state,
            json!({ "ok": false, "nickname": nickname, "query": query, "reason": "Add a song name or link after m!p" }),
        );
        return;
    }
    if query.chars().count() > QUERY_MAX_LENGTH {
        notify(
            &state,
            json!({ "ok": false, "nickname": nickname, "query": query, "reason": "That name is too long" }),
        );
        return;
    }
    let already_waiting = state
        .songs
        .lock()
        .map(|s| has_viewer_request(&s, &user))
        .unwrap_or(false);
    if already_waiting {
        notify(
            &state,
            json!({ "ok": false, "nickname": nickname, "query": query, "reason": "You already have a request waiting" }),
        );
        return;
    }

    match resolve_request_song(&state, &query).await {
        Err(reason) => {
            tracing::info!("[song] refused {nickname} (\"{query}\"): {reason}");
            notify(
                &state,
                json!({ "ok": false, "nickname": nickname, "query": query, "reason": reason }),
            );
        }
        Ok(mut song) => {
            song.id = state.next_song_id();
            song.user = Some(user.clone());
            song.nickname = Some(nickname.clone());
            song.is_filler = false;
            song.requested_at = now_ms();

            let (auto_approve, started) = {
                let Ok(mut songs) = state.songs.lock() else { return };
                // Re-check after the awaits: another comment from the same
                // viewer may have landed meanwhile.
                if has_viewer_request(&songs, &user) {
                    return;
                }
                let auto = songs.auto_approve;
                if auto {
                    songs.approved.push(song.clone());
                    let started = songs.now_playing.is_none();
                    (auto, started)
                } else {
                    songs.pending.push(song.clone());
                    (auto, false)
                }
            };

            if started {
                advance_song(&state);
            } else {
                state.broadcast(song_state_payload(&state));
            }
            if auto_approve {
                tracing::info!("[song] auto-approved \"{}\" from {nickname}", song.title);
            } else {
                tracing::info!("[song] queued \"{}\" from {nickname}", song.title);
            }
            notify(
                &state,
                json!({ "ok": true, "nickname": nickname, "query": query, "title": song.title, "auto": auto_approve }),
            );
        }
    }
}

fn next_filler(state: &AppState, songs: &mut Songs) -> Option<Song> {
    if songs.fillers.is_empty() {
        return None;
    }
    let filler = songs.fillers[songs.filler_cursor % songs.fillers.len()].clone();
    songs.filler_cursor += 1;
    let mut song = filler;
    song.id = state.next_song_id();
    song.is_filler = true;
    song.nickname = None;
    song.user = None;
    Some(song)
}

/// An approved viewer request always wins over a filler; playing a viewer
/// request consumes it, playing a filler does not.
pub fn advance_song(state: &AppState) {
    {
        let Ok(mut songs) = state.songs.lock() else { return };
        let next = if !songs.approved.is_empty() {
            Some(songs.approved.remove(0))
        } else {
            next_filler(state, &mut songs)
        };
        if let Some(song) = &next {
            songs.recent_video_ids.push(song.video_id.clone());
            while songs.recent_video_ids.len() > RECENT_VIDEO_MEMORY {
                songs.recent_video_ids.remove(0);
            }
        }
        songs.now_playing = next;
    }
    state.broadcast(song_state_payload(state));
}

pub async fn add_filler_song(state: std::sync::Arc<AppState>, input: String) -> Result<(), String> {
    let raw = input.trim().to_string();
    if raw.is_empty() {
        return Err("Enter a YouTube link or a song name".into());
    }
    if raw.chars().count() > QUERY_MAX_LENGTH {
        return Err("That name is too long".into());
    }
    let mut song = resolve_request_song(&state, &raw).await?;
    song.id = state.next_song_id();
    let mut songs = state.songs.lock().map_err(|_| "Song queue unavailable")?;
    if songs.fillers.iter().any(|f| f.video_id == song.video_id) {
        return Err("That song is already a Filler".into());
    }
    songs.fillers.push(song);
    save_fillers(&state.fillers_path, &songs.fillers);
    drop(songs);
    state.broadcast(song_state_payload(&state));
    Ok(())
}

pub fn song_state_payload(state: &AppState) -> Value {
    let config = state.config_snapshot();
    let Ok(songs) = state.songs.lock() else {
        return json!({ "type": "song-state" });
    };
    json!({
        "type": "song-state",
        "enabled": songs.enabled,
        "autoApprove": songs.auto_approve,
        "hasApiKey": !config.youtube_api_key.trim().is_empty(),
        "pending": songs.pending,
        "approved": songs.approved,
        "nowPlaying": songs.now_playing,
        "fillers": songs.fillers,
        "maxDurationSec": config.song_max_duration_sec,
        "command": "m!p",
    })
}

pub fn remove_filler(state: &AppState, id: &str) {
    let Ok(mut songs) = state.songs.lock() else { return };
    let before = songs.fillers.len();
    songs.fillers.retain(|song| song.id != id);
    if songs.fillers.len() == before {
        return;
    }
    save_fillers(&state.fillers_path, &songs.fillers);
    drop(songs);
    state.broadcast(song_state_payload(state));
}

fn urlencoding(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_command_and_links() {
        assert_eq!(
            parse_song_command("m!p the weeknd blinding lights").as_deref(),
            Some("the weeknd blinding lights")
        );
        assert_eq!(parse_song_command("/music"), Some(String::new()));
        assert_eq!(parse_song_command("music please"), None);
        assert_eq!(
            extract_video_id("https://youtu.be/9bZkp7q19f0").as_deref(),
            Some("9bZkp7q19f0")
        );
        assert_eq!(
            extract_video_id("https://www.youtube.com/shorts/60ItHLz5WEA").as_deref(),
            Some("60ItHLz5WEA")
        );
        assert_eq!(extract_video_id("just a name"), None);
    }

    #[test]
    fn parses_iso_durations() {
        assert_eq!(parse_iso_duration("PT4M13S"), Some(253));
        assert_eq!(parse_iso_duration("P0D"), Some(0));
        assert_eq!(parse_iso_duration("nonsense"), None);
    }

    #[test]
    fn collects_candidates_from_yt_initial_data() {
        let html = r#"<script>var ytInitialData = {"contents":{"videoRenderer":{"videoId":"4NRXx6U8ABQ","lengthText":{"simpleText":"3:22"}}}};</script>"#;
        assert_eq!(extract_video_ids_from_html(html), vec!["4NRXx6U8ABQ"]);
    }

    #[test]
    fn prefers_recorded_videos_over_live() {
        let html = r#"<script>ytInitialData = {"a":{"videoRenderer":{"videoId":"AAAAAAAAAAA","badges":[{"metadataBadgeRenderer":{"label":"LIVE"}}]}},"b":{"videoRenderer":{"videoId":"BBBBBBBBBBB","lengthText":{"simpleText":"2:00"}}}};</script>"#;
        assert_eq!(extract_video_ids_from_html(html), vec!["BBBBBBBBBBB"]);
    }
}
