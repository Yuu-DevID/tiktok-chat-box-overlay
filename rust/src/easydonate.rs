use serde_json::{json, Value};
use std::collections::HashMap;

use crate::config::Config;
use crate::state::AppState;

const MOCK_LEADERBOARD: &[(&str, f64)] = &[
    ("sleeping", 5428.15),
    ("kai_gamer", 2040.0),
    ("pim.streamfan", 1580.5),
    ("tanawat_th", 990.0),
    ("user_888", 720.0),
    ("nampeung_99", 500.0),
    ("boss_888", 350.0),
    ("malee_cat", 220.0),
    ("lek_fc", 150.0),
    ("skyfall", 100.0),
];

/// EasyDonate is proxied so the API key never reaches the browser. Without a
/// key the widget still works on the built-in sample board.
pub async fn leaderboard(state: &AppState) -> Result<(Value, bool), String> {
    let config = state.config_snapshot();
    if config.easydonate_api_key.trim().is_empty() {
        let list: Vec<Value> = MOCK_LEADERBOARD
            .iter()
            .map(|(name, amount)| json!({ "name": name, "amount": amount }))
            .collect();
        return Ok((Value::Array(merge_entries(state, list)), true));
    }

    let mut donations: Vec<Value> = Vec::new();
    let mut page = 1_u32;
    let mut total_page = 1_u32;
    while page <= total_page && page <= 20 {
        let response = state
            .http
            .get(format!(
                "{}/api/v1/donations?size=100&page={page}",
                config.easydonate_api_base_url.trim_end_matches('/')
            ))
            .bearer_auth(config.easydonate_api_key.trim())
            .send()
            .await
            .map_err(|err| format!("EasyDonate request failed: {err}"))?;
        if !response.status().is_success() {
            return Err(format!("EasyDonate returned {}", response.status()));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|err| format!("EasyDonate parse error: {err}"))?;
        total_page = payload
            .pointer("/data/totalPage")
            .and_then(Value::as_u64)
            .unwrap_or(1) as u32;
        if let Some(histories) = payload.pointer("/data/histories").and_then(Value::as_array) {
            donations.extend(histories.iter().cloned());
        }
        page += 1;
    }

    let entries: Vec<Value> = donations
        .iter()
        .filter(|donation| donation.get("status").and_then(Value::as_str) == Some("SUCCESS"))
        .map(|donation| {
            json!({
                "name": donation.get("donatorName").and_then(Value::as_str).unwrap_or("Anonymous"),
                "amount": donation.get("amount").and_then(Value::as_f64).unwrap_or(0.0),
            })
        })
        .collect();
    Ok((Value::Array(merge_entries(state, entries)), false))
}

fn read_json(path: &std::path::Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn merge_entries(state: &AppState, list: Vec<Value>) -> Vec<Value> {
    let extra = read_json(&Config::extra_donors_path(&state.config_path))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let aliases = read_json(&Config::donor_aliases_path(&state.config_path))
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let alias_map: HashMap<String, String> = aliases
        .iter()
        .filter_map(|(alias, name)| {
            name.as_str()
                .map(|name| (alias.trim().to_lowercase(), name.trim().to_string()))
        })
        .collect();

    let mut merged: HashMap<String, (String, f64)> = HashMap::new();
    for entry in list.iter().chain(extra.iter()) {
        let raw_name = entry.get("name").and_then(Value::as_str).unwrap_or("Anonymous");
        let name = alias_map
            .get(&raw_name.trim().to_lowercase())
            .cloned()
            .unwrap_or_else(|| raw_name.trim().to_string());
        let amount = entry.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
        let key = name.to_lowercase();
        let slot = merged.entry(key).or_insert((name, 0.0));
        slot.1 += amount;
    }
    let mut entries: Vec<Value> = merged
        .into_values()
        .map(|(name, amount)| json!({ "name": name, "amount": amount }))
        .collect();
    entries.sort_by(|a, b| {
        b.get("amount")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .partial_cmp(&a.get("amount").and_then(Value::as_f64).unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    entries
}

