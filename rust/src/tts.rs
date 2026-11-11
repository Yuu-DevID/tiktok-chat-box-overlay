use std::time::Duration;

use crate::state::AppState;

/// Google Translate TTS, proxied so the browser can fetch it same-origin.
pub async fn google(state: &AppState, text: &str, lang: &str) -> Result<(Vec<u8>, &'static str), String> {
    let clipped: String = text.chars().take(200).collect();
    let response = state
        .http
        .get("https://translate.google.com/translate_tts")
        .query(&[
            ("ie", "UTF-8"),
            ("tl", lang),
            ("client", "tw-ob"),
            ("q", clipped.as_str()),
        ])
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://translate.google.com/")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("TTS proxy failed: {err}"))?;
    if !response.status().is_success() {
        return Err("TTS upstream error".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("TTS proxy failed: {err}"))?;
    Ok((bytes.to_vec(), "audio/mpeg"))
}

/// Self-hosted engine (tts-engine-project): POST /v1/tts {text, lang} -> WAV.
pub async fn local(state: &AppState, text: &str, lang: &str) -> Result<(Vec<u8>, &'static str), String> {
    let config = state.config_snapshot();
    let response = state
        .http
        .post(config.tts_engine_url.trim())
        .json(&serde_json::json!({ "text": text, "lang": lang }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("TTS proxy failed: {err}"))?;
    if !response.status().is_success() {
        return Err("TTS upstream error".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("TTS proxy failed: {err}"))?;
    Ok((bytes.to_vec(), "audio/wav"))
}
