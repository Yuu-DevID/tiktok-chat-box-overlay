use chrono::Local;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// One JSON object per line in `logs/live-YYYY-MM-DD.jsonl`, same tracing
/// convention as the Node version: `tiktok-raw` -> `broadcast` -> `overlay`.
pub struct LiveLog {
    dir: PathBuf,
    writer: Mutex<Option<(String, fs::File)>>,
}

impl LiveLog {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, writer: Mutex::new(None) }
    }

    pub fn write(&self, stage: &str, mut data: Value) {
        let today = Local::now().format("%Y-%m-%d").to_string();
        let Ok(mut guard) = self.writer.lock() else { return };
        let needs_open = match guard.as_ref() {
            Some((date, _)) => date != &today,
            None => true,
        };
        if needs_open {
            if let Err(err) = fs::create_dir_all(&self.dir) {
                tracing::warn!("live log dir: {err}");
                return;
            }
            match OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(format!("live-{today}.jsonl")))
            {
                Ok(file) => *guard = Some((today.clone(), file)),
                Err(err) => {
                    tracing::warn!("live log open: {err}");
                    return;
                }
            }
        }
        let Some((_, file)) = guard.as_mut() else { return };
        if let Some(object) = data.as_object_mut() {
            object.insert("t".into(), json!(Local::now().to_rfc3339()));
            object.insert("stage".into(), json!(stage));
        }
        let line = serde_json::to_string(&data).unwrap_or_else(|_| "{}".into());
        let _ = writeln!(file, "{line}");
    }
}
