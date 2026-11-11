---
status: accepted
amends: 0001-youtube-link-only-song-requests.md
---

# Song requests accept `m!p <name>` as well as links, with auto-approve

ADR 0001 made requests link-only so a stream would never burn its 10,000-unit daily Data API quota on
`search.list` (100 units per call). That protected the quota but pushed the work onto viewers: finding
and pasting a YouTube link is a real drop in participation, especially on mobile. In practice the
feature went unused unless the streamer asked for links by hand.

We now accept `m!p <song name>` and `m!p <YouTube link>`, with `m!p` as the advertised command
(`/music` remains an alias for older messages). A valid request under **Auto** approval starts
playing without the streamer touching the panel; Manual mode still exists and is one switch away.

## How the quota problem is avoided

Name searches are resolved by fetching YouTube's public results page
(`/results?search_query=...&sp=EgIQAQ`) and reading the first playable `videoRenderer` ids out of
`ytInitialData`. That costs no quota at all. `videos.list` (1 unit) still validates embeddable,
duration and region before anything is queued, so the safety from ADR 0001 is unchanged.

If the results page cannot be parsed (YouTube changed its markup), the server logs a warning and falls
back to `search.list` with `maxResults=5`. That fallback is intentionally visible in the log rather
than silent, because it is the one path that can exhaust the quota mid-stream.

## Multiple candidates

The top search hit is often a live stream, a Short, or a video whose owner disabled embedding. A
one-shot lookup would refuse the request even though the song exists further down the page. The
search therefore returns up to 8 candidate ids and validation walks them in order, queueing the first
playable one. This is also why the direct-link path kept its single candidate: the viewer chose that
exact video, so silently substituting another would be wrong.

## Consequences

- The viewer-side cost that ADR 0001 accepted is gone; the streamer's queue is noisier, which is why
  Auto is on by default and the per-viewer one-request cap, duplicate-video refusal and recent-play
  memory still apply.
- The Player, validation step and stored Filler songs stay YouTube-shaped, so the switching-player
  cost from ADR 0001 is unchanged.
- If TikTok mutes a stream for copyright, this still fails outright and local audio files remain the
  only workable option.
- Refusals stay silent in TikTok chat (it is read-only to us). The reason is surfaced in the chat
  window and panel notices instead, where only the streamer can see it.
