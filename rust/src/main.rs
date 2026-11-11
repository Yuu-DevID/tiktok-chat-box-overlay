use std::env;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

fn main() {
    // On Wayland sessions, GTK/WebKit2GTK often needs X11 (XWayland) for correct
    // window handle/embedding behavior in this setup. Set before window creation.
    if env::var_os("XDG_SESSION_TYPE").as_deref() == Some(std::ffi::OsStr::new("wayland"))
        && env::var_os("GDK_BACKEND").is_none()
    {
        // Safe here: single-threaded, before GTK/tao initialization.
        unsafe { env::set_var("GDK_BACKEND", "x11"); }
    }

    let url = env::var("CHATBOX_URL")
        .unwrap_or_else(|_| "http://localhost:8080/chatbox".to_string());

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("TikTok Chat")
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_inner_size(tao::dpi::LogicalSize::new(430.0, 820.0))
        .build(&event_loop)
        .expect("failed to create window");

    let _webview = WebViewBuilder::new()
        .with_url(&url)
        .with_transparent(true)
        .build(&window)
        .expect("failed to create webview");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}