use std::env;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

fn main() {
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
        .with_ipc_handler(move |window, _req| {
            // Allow the page to request window dragging via postMessage("drag").
            window.start_dragging().ok();
        })
        .build(&window)
        .expect("failed to create webview");

    // Inject a drag handle: holding mouse down on the top bar drags the window.
    let _ = _webview.evaluate_script(
        r#"
        (function(){
            const bar = document.getElementById('topbar') || document.querySelector('header');
            if(!bar) return;
            bar.style.cursor = 'move';
            bar.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                if (window.ipc && window.ipc.postMessage) window.ipc.postMessage('drag');
            });
        })();
        "#,
    );

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}