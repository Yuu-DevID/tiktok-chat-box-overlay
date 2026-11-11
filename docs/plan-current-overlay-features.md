# Plan: TikTok live overlay — chat, gift, member, TTS

## Goal

Give a streamer a browser-source overlay plus a pinnable desktop chat window that shows live
chat/gift/join activity and reads chat comments aloud (English by default, switchable), without paid
APIs.

## Decisions to grill

1. **TTS provider**: switchable at runtime from the control room between `google` (Google Translate's
   unofficial `translate_tts` endpoint, default) and `local` (self-hosted `tts-engine-project`,
   `POST /v1/tts`). The spoken language is a separate setting (`en` default, `id`, `th`). Both proxied through our own `/tts` server route so the browser can fetch audio same-origin
   with a plain GET regardless of which is selected; server holds the current choice in memory, resets to
   `google` on restart. Requires the local engine running separately
   (`uvicorn tts_engine.app:app`, see `D:\Work Space\Code Study\work-shop\2026\tts-engine-project`) for the
   `local` option to work. Alternatives considered and rejected: Google Cloud TTS / Azure TTS (both need
   paid API keys).
2. **Gift streak collapsing**: only broadcast a gift event once `repeatEnd === 1` for streakable gifts
   (`gift.type === 1`), to avoid one card per tap during a held-down gift streak.
3. **Repeat flood / Pattern collapse scope**: both only mute TTS — chat cards always render every message
   unfiltered. Two independent mechanisms that used to share threshold 3 by coincidence, since diverged:
   - **Repeat flood**: per-viewer identical-Comment repeat >3 in a row → stop reading repeats
   - **Pattern collapse**: in-Comment repeated pattern (chars or short substrings), 3+ reps in a row,
     collapsed before speaking — to 2 reps if the repeat spans the whole Comment, to 1 rep (the plain
     word) if it's trailing elongation stuck onto a real word (e.g. "เก่งมากกกกกกก" → "เก่งมาก")
4. **Blocked-word list**: `widgets/chat/chat.js` (moved here when `overlay.html` was split into the
   current widget-per-page structure — no longer inline in `overlay.html`, which has since been
   deleted). Hardcoded regex for `หี` + optional tone mark when it's the whole syllable, plus `แตด`;
   plus a standalone-word match for "เกย์"/"เก"/"gay" in any casing (including single-letter-spaced
   evasion like "เ ก"/"G A Y"); plus any Comment containing a "+" character. All never spoken, always
   still shown in chat.
5. **Gibberish spam**: a Comment made of a short chunk repeated 3+ times with *inconsistent* spacing
   between reps (e.g. "ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะ จะ ตุก จี๊ ๆ ๆ ...") can't be cleanly collapsed like
   Pattern collapse above, since the reps aren't literally identical — the whole Comment is suppressed
   from TTS instead, same as a Blocked word.
6. **TTS speed**: playback rate for spoken TTS, same server-held/panel-controlled/WS-synced pattern as
   TTS provider above (`ttsSpeed` in `rust/src/state.rs`, in-memory, resets to 1.5 on restart).
7. **Member joins**: shown as cards, deliberately never read aloud.
8. **Config**: `.env` + `dotenv`, no config file beyond that; `MOCK_MODE` for local testing without a live
   TikTok session.

## Out of scope (explicit non-goals)

- Multi-room / multi-streamer support
- Persisted history (everything is in-memory/localStorage, resets on refresh)
- Paid TTS providers

## Not yet implemented (open, not a non-goal)

- Viewer count / like count / question events — likely to be added incrementally, same pattern as
  Gift and Member join (pick one, confirm real event field names via debug logging, wire up server + overlay)

## Session stats summary (implemented)

9. **Trigger**: manual only — a button in the panel widget sends `show-summary` over WS; the server
   snapshots its in-memory counters and broadcasts a `summary` message. No auto-display on `DISCONNECTED`
   (rejected for now — can revisit if the streamer wants it).
10. **Storage**: plain counters on the server (`Stats` in `rust/src/state.rs`), incremented from inside
   `broadcast()` so both mock and real event paths update them for free. Resets on server restart, same
   as everything else — no file/db persistence (see non-goals).
11. **Gift value**: shown in diamonds (`gift.diamondCount * repeatCount`), not baht — diamonds is what the
   TikTok event actually reports; converting to baht would need a rate that isn't available server-side.

## BRB Timer (implemented)

12. **Sync model**: server holds `endsAt` (an epoch timestamp), not a ticking counter — clients compute
    their own remaining time from `endsAt - Date.now()` on a local interval. WS traffic is limited to
    control events (start/pause/resume/reset/message), not a per-second tick broadcast.
13. **Sync-on-connect**: every new WS connection immediately receives the current `timerState` — this is
    what makes reloading `/timer` (or opening `/panel` late) resume mid-countdown instead of resetting to
    zero. Verified: a client joining ~2s after a 10s countdown started receives `endsAt` reflecting ~8s
    remaining, not the original 10s.
14. **Expiry**: a single server-side `setInterval` (250ms) flips `running` → `ended`, so all clients agree
    on the moment it ended instead of each browser source deciding independently.
15. **Trigger surface**: folded into the existing `/panel` (not a separate control page) — same reasoning
    as `show-summary`: one tab for the streamer to watch during a live. Duration presets (1/5/10/15 min)
    start immediately on click; a custom minute/second input pairs with a separate Start button.
16. **Storage**: `Timer` in `rust/src/state.rs`, in-memory, resets on server restart — same non-goal as
    everything else in this project.

## Desktop chat window (implemented)

17. **Shape**: `/chatbox` is a separate, compact page opened as a real desktop window by
    `bin/chatbox-window.sh` (Chromium `--app`), so the streamer uses the desktop environment's own
    pin / "Keep Above Others" instead of building always-on-top behaviour ourselves. The launcher
    starts the server if it isn't up and uses a dedicated browser profile so it never becomes a tab in
    the daily browser. A loopback-only `/api/open-window` route lets the control room open it too.
18. **Scope**: live rows (chat/gift/follow/join), filter, click-to-pin with auto-unpin, now playing,
    BRB timer, and the switches used mid-stream (TTS on/off, TTS language, requests, auto approval).
    The full queue and timer inputs stay in `/panel`.
19. **Demo mode**: `/chatbox?demo=1` fills the window with sample rows so it can be sized and
    positioned before going live.

## Song requests by name (implemented, amends ADR 0001)

20. **Command**: `m!p <song name>` or `m!p <YouTube link>`; `/music <link>` remains an alias. A bare
    link or name without the command is an ordinary Comment.
21. **Search without quota**: name requests read YouTube's public results page (`ytInitialData`), which
    costs no Data API quota. `videos.list` still validates every candidate (1 unit). `search.list` is
    only a logged fallback when the page markup changes.
22. **Candidates**: the first 8 search hits are validated in order, so a top hit that is a live stream,
    too long, or un-embeddable falls through to the next playable result instead of refusing the request.
23. **Auto approval**: on by default, a valid request starts playing immediately. Off restores the
    manual pending list. Validation and the per-viewer / duplicate / recent-play filters are unchanged.
24. **Feedback**: refusals stay silent in TikTok chat, but a `song-request-notice` goes to the panel and
    chat window with the reason, so the streamer can see why a request didn't play.
