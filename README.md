# TikTok Live Reader — Overlay + Desktop Chat Window

A Rust desktop app for TikTok LIVE: real-time chat, gifts, follows and joins in OBS overlays, a
separate pinnable chat window, text-to-speech, and YouTube song requests from chat (`m!p`).

The app is one small binary. It serves the Control Room and every transparent overlay on
`http://127.0.0.1:8080` and opens the desktop windows itself.

## Requirements

- Linux (tested on CachyOS / KDE Plasma Wayland)
- A Chromium-based browser for the app windows: Brave, Chrome, Chromium, Edge or Vivaldi
- Rust only if you build from source

## Build

```bash
cd rust
cargo build --release
```

The binary is `rust/target/release/tiktok-live-reader`. Copy it anywhere; it has no Node or runtime
dependency of its own.

## Run

```bash
./tiktok-live-reader
```

On the first run the Control Room opens on **Set up your live** instead of an empty dashboard. Fill
in your TikTok username and press **Save & connect**; the overlay cards appear after that.

Useful options:

```bash
tiktok-live-reader --serve                 # server only, no window (OBS-only machines)
tiktok-live-reader --view chatbox          # open just the chat window
tiktok-live-reader --view panel            # open just the streamer panel
tiktok-live-reader --port 8090             # another loopback port
tiktok-live-reader --config ./config.json  # explicit config file
tiktok-live-reader --mock --mock-chat      # fake events, no TikTok connection
tiktok-live-reader --help
```

The account must be **currently live** or the connection retries every 10 seconds, so you can start
the app before going live.

## Setup

The Control Room's Setup view stores:

- **TikTok username** (with or without `@`)
- Optional **sign API key**, session id / target idc, and live cookies for rooms that need them
- **YouTube API key** and region for song validation
- **Song max length** (default 10 minutes)
- EasyDonate API key for the Top donate overlay
- Optional TikTok LIVE Studio helper paths

The config is written to `./config.json` when that file already exists, otherwise to
`$XDG_CONFIG_HOME/tiktok-live-reader/config.json` (falling back to `~/.config/...`). It is created
with `0600` permissions. On the first Rust run, values from an existing `.env` are imported.

## Desktop windows

The app opens a separate window in app mode (Brave/Chrome/Chromium), not a browser tab:

- **Chat window** — compact live chat, click a name to pin, filter, TTS switches, BRB timer.
  Open it with the **Chat window** button in the Control Room, or `--view chatbox`.
- **Streamer panel** — pin comments, approve songs, run the BRB timer and show the session summary.
- **Control Room** — copy overlay URLs, preview them, and change setup.

On KDE Plasma, pin a window with **title bar → More Actions → Keep Above Others** (or a Window Rule).
The same works on other desktops with their own "always on top" action. Each view uses its own
browser profile under `~/.local/share/tiktok-live-reader/window-<view>/`, so the windows behave like
independent apps.

If you prefer the embedded WebKit window, set `TIKTOK_READER_NATIVE_WINDOW=1`. It is off by default
because WebKitGTK can render a blank surface on hybrid NVIDIA/AMD Wayland systems. Set
`TIKTOK_READER_BROWSER=/path/to/browser` to pick a specific browser.

## Use with OBS / Streamlabs

1. Start the app and leave it running.
2. Add a **Browser Source** for each overlay you want, using the URLs from the Control Room.
3. Size and position each source independently in your scene.
4. Control TTS from the Control Room, chat window or panel — overlay pages have no on-page controls.
5. TTS audio plays through the `/chat` Browser Source; capture that source's audio or desktop audio.

Overlay URLs:

| URL | What it shows |
| --- | --- |
| `/chat` | Chat, gifts and joins (also plays TTS) |
| `/pinned` | The comment you pinned, shown large |
| `/follow` | New follower alert |
| `/top-donate` | EasyDonate leaderboard |
| `/timer` | BRB countdown |
| `/summary` | Session totals, shown on demand |
| `/music` | The YouTube player for `m!p` requests |

All widgets share the Control Room design tokens (`widgets/shared/overlay-theme.css`) and stay
transparent so OBS can composite them over gameplay.

## Song requests

Viewers ask in chat with either form:

```text
m!p lofi hip hop radio
m!p https://youtu.be/dQw4w9WgXcQ
```

- `m!p <name>` reads YouTube's public results page (no quota) and validates candidates until one is
  playable. `m!p <link>` uses the link directly.
- Validation uses `videos.list` (1 quota unit) to check embeddable / length / region.
- **Auto** plays valid requests immediately (default); turn it off to approve each request in the
  Panel.
- One request per viewer, no duplicate queue entries, and refusals are silent in TikTok chat — the
  reason is shown only to the streamer.
- The feature stays off until a YouTube API key is configured.

## TTS

The `/tts` endpoint proxies either a self-hosted engine or Google Translate's public `translate_tts`
(free, no API key). Language (`en`, `id`, `th`), speed and on/off are synced live over the WebSocket
from the Control Room, chat window and panel.

## Mock mode

```bash
./tiktok-live-reader --mock --mock-chat
```

`--mock` fakes follows and a connected state; `--mock-chat` adds comments, gifts and joins on
intervals. Useful for positioning OBS sources without going live.

## How it works

The binary is an Axum HTTP + WebSocket server bound to `127.0.0.1` plus a window launcher.

- `src/tiktok.rs` — connector loop, reconnect backoff, event normalization
- `src/state.rs` — shared state, broadcast channel, stats, songs, TTS and timer payloads
- `src/songs.rs` — `m!p` parsing, YouTube scraping/validation, queue advance
- `src/server.rs` — routes, WebSocket sessions, static embedding, mock events
- `src/config.rs` / `src/live_log.rs` — config file, live JSONL logs
- `src/profanity.rs`, `src/easydonate.rs`, `src/tts.rs`
- `src/window.rs` — app-mode windows (embedded WebKit fallback)

Every overlay is a plain HTML/CSS/JS page under `widgets/`, embedded into the binary at build time.
No bundler, no external CDN at runtime; the frontend connects to the same origin at `/ws`.

The old Node implementation (`server.js`, `npm start`) is kept only for reference and is no longer
the app.

## Notes / caveats

- Uses the unofficial TikTok protocol via
  [`tiktok-live-connector-rs`](https://github.com/simnJS/tiktok-live-connector-rs), pinned to a
  tested revision. TikTok protocol changes can break it.
- Connecting with just a username relies on the free Euler Stream signing limit; a paid `signApiKey`
  lifts it.
- YouTube name search scrapes public results. If the markup changes, it falls back to `search.list`
  (100 quota units) and logs a warning.
- Session state (stats, songs, timer, TTS toggles) is in memory and resets when the app restarts.

See [`CONTEXT.md`](./CONTEXT.md) for domain language and [`docs/adr/`](./docs/adr/) for decisions.
