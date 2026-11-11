use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct WindowSpec {
    title: &'static str,
    width: u32,
    height: u32,
    min_width: f64,
    min_height: f64,
}

fn spec_for(view: &str, port: u16) -> (WindowSpec, String) {
    let base = format!("http://127.0.0.1:{port}");
    match view {
        "chatbox" => (
            WindowSpec {
                title: "TikTok chat",
                width: 430,
                height: 860,
                min_width: 360.0,
                min_height: 520.0,
            },
            format!("{base}/chatbox?window=1"),
        ),
        "panel" => (
            WindowSpec {
                title: "TikTok Live Reader — Panel",
                width: 980,
                height: 800,
                min_width: 720.0,
                min_height: 560.0,
            },
            format!("{base}/panel"),
        ),
        _ => (
            WindowSpec {
                title: "TikTok Live Reader",
                width: 1240,
                height: 820,
                min_width: 960.0,
                min_height: 640.0,
            },
            format!("{base}/"),
        ),
    }
}

/// Chromium-based browsers give us a real separate window with an app frame,
/// which KDE can pin with "Keep Above Others". WebKitGTK embedding on hybrid
/// NVIDIA/AMD Wayland systems can paint a blank surface (GBM buffer errors),
/// so a browser window is the reliable default. Set
/// TIKTOK_READER_NATIVE_WINDOW=1 to force the embedded webview instead.
pub fn open(view: &str, port: u16) -> Result<(), String> {
    let (spec, url) = spec_for(view, port);
    if std::env::var_os("TIKTOK_READER_NATIVE_WINDOW").is_some() {
        return open_webview(spec, url);
    }
    match browser_path() {
        Some(browser) => open_browser(&browser, view, &spec, &url),
        None => {
            tracing::warn!("no Chromium-based browser found, falling back to embedded webview");
            open_webview(spec, url)
        }
    }
}

fn browser_path() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("TIKTOK_READER_BROWSER") {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Some(path);
        }
    }
    let names = [
        "brave",
        "brave-browser",
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "vivaldi-stable",
    ];
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn profile_dir(view: &str) -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("tiktok-live-reader").join(format!("window-{view}"))
}

fn open_browser(browser: &Path, view: &str, spec: &WindowSpec, url: &str) -> Result<(), String> {
    let profile = profile_dir(view);
    std::fs::create_dir_all(&profile)
        .map_err(|err| format!("could not create window profile {}: {err}", profile.display()))?;

    let mut command = Command::new(browser);
    command
        .arg(format!("--app={url}"))
        .arg(format!("--window-size={},{}", spec.width, spec.height))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-features=Translate")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|err| format!("could not open {}: {err}", browser.display()))?
        .wait()
        .map_err(|err| format!("window closed with an error: {err}"))?;
    Ok(())
}

/// Embedded fallback. Kept for machines without a Chromium browser; the
/// opaque background means a slow first paint shows the stage, not a blank
/// white rectangle.
fn open_webview(spec: WindowSpec, url: String) -> Result<(), String> {
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::window::WindowBuilder;
    use wry::WebViewBuilder;

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title(spec.title)
        .with_inner_size(LogicalSize::new(spec.width as f64, spec.height as f64))
        .with_min_inner_size(LogicalSize::new(spec.min_width, spec.min_height))
        .with_resizable(true)
        .build(&event_loop)
        .map_err(|err| format!("could not create window: {err}"))?;

    let webview: wry::WebView = WebViewBuilder::new()
        .with_url(url)
        .with_background_color((26, 19, 48, 255))
        .with_devtools(cfg!(debug_assertions))
        .build(&window)
        .map_err(|err| format!("could not create webview: {err}"))?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            let _ = &webview;
            *control_flow = ControlFlow::Exit;
        }
    });
}
