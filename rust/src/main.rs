mod config;
mod easydonate;
mod live_log;
mod profanity;
mod server;
mod songs;
mod state;
mod tiktok;
mod tts;
mod window;

use std::sync::Arc;
use std::time::Duration;

struct Args {
    serve: bool,
    view: String,
    port: u16,
    config: Option<String>,
    mock: bool,
    mock_chat: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        serve: false,
        view: "control".into(),
        port: 8080,
        config: None,
        mock: std::env::var("MOCK").as_deref() == Ok("1"),
        mock_chat: std::env::var("MOCK_CHAT").as_deref() == Ok("1"),
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--serve" | "--headless" => args.serve = true,
            "--mock" => args.mock = true,
            "--mock-chat" => {
                args.mock = true;
                args.mock_chat = true;
            }
            "--view" => {
                if let Some(view) = iter.next() {
                    args.view = view;
                }
            }
            "--port" => {
                if let Some(port) = iter.next().and_then(|value| value.parse::<u16>().ok()) {
                    args.port = port;
                }
            }
            "--config" => args.config = iter.next(),
            "--help" | "-h" => {
                println!(
                    "TikTok Live Reader\n\n\
                     Usage: tiktok-live-reader [options]\n\n\
                     Options:\n  \
                     --serve            Run the server without a window (for OBS-only machines)\n  \
                     --view <name>      Window to open: control (default), chatbox or panel\n  \
                     --port <number>    HTTP port (default 8080, loopback only)\n  \
                     --config <path>    Config file (default ./config.json or ~/.config/tiktok-live-reader/config.json)\n  \
                     --mock             Fake follows and a connected state, no TikTok connection\n  \
                     --mock-chat        Fake chat, gifts and joins too (implies --mock)\n"
                );
                std::process::exit(0);
            }
            _ => {}
        }
    }
    args
}

fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .without_time()
        .try_init();
}

fn main() {
    init_logging();
    let args = parse_args();

    // WebKitGTK's frame embedding is still more reliable through XWayland on
    // KDE Wayland. Users can opt into native Wayland with
    // TIKTOK_READER_NATIVE_WAYLAND=1.
    if std::env::var_os("XDG_SESSION_TYPE").as_deref() == Some(std::ffi::OsStr::new("wayland"))
        && std::env::var_os("GDK_BACKEND").is_none()
        && std::env::var_os("TIKTOK_READER_NATIVE_WAYLAND").is_none()
    {
        // Safe: called before GTK/tao initialisation.
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    unsafe { std::env::set_var("TIKTOK_READER_PORT", args.port.to_string()) };

    let already_running = server::server_is_up(args.port);
    if !already_running && args.serve {
        run_server(&args);
        return;
    }
    if !already_running {
        start_server(&args);
    } else {
        tracing::info!("using running server on http://127.0.0.1:{}", args.port);
    }

    if args.serve {
        // The server owned by another process; nothing to do.
        return;
    }

    if let Err(err) = window::open(&args.view, args.port) {
        tracing::error!("{err}");
        eprintln!(
            "Open http://127.0.0.1:{} in a browser instead (the server is running).",
            args.port
        );
        if !already_running {
            // Keep serving so the printed URL is useful.
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    }
}

fn run_server(args: &Args) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let config_path = config::resolve_config_path(args.config.as_deref());
    let config = config::load(&config_path, args.config.is_none());
    let state = Arc::new(state::AppState::new(
        config,
        config_path,
        args.port,
        args.mock,
        args.mock_chat,
    ));
    match server::bind(args.port) {
        Ok(listener) => {
            eprintln!("TikTok Live Reader: http://127.0.0.1:{}", args.port);
            runtime.block_on(server::run(state, listener));
        }
        Err(err) => eprintln!("Could not listen on 127.0.0.1:{}: {err}", args.port),
    }
}

fn start_server(args: &Args) {
    let config_path = config::resolve_config_path(args.config.as_deref());
    let config = config::load(&config_path, args.config.is_none());
    tracing::info!("config: {}", config_path.display());
    let state = Arc::new(state::AppState::new(
        config,
        config_path,
        args.port,
        args.mock,
        args.mock_chat,
    ));
    let listener = match server::bind(args.port) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("Could not listen on 127.0.0.1:{}: {err}", args.port);
            std::process::exit(1);
        }
    };
    std::thread::Builder::new()
        .name("overlay-server".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    eprintln!("tokio runtime: {err}");
                    std::process::exit(1);
                }
            };
            runtime.block_on(server::run(state, listener));
        })
        .expect("server thread");
    // Give the listener a moment to accept before the webview asks for HTML.
    for _ in 0..40 {
        if server::server_is_up(args.port) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
