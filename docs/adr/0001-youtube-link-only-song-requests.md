---
status: amended by 0002-song-requests-by-name-with-m!p.md
---

# Song requests are YouTube links only, validated through the Data API

We want viewers to be able to request songs during a live. Playback happens in a
`/music` browser source driving a YouTube IFrame Player, and a request is only ever
a YouTube link pasted into chat — never a song title we look up. Every link is
checked with `videos.list` before it can be queued, which makes a YouTube Data API
key a hard requirement: without one the feature is off rather than partially working.

## Considered Options

Letting viewers type a song name and resolving it with `search.list` is the obvious
design, and it's the one we rejected. The free Data API quota is 10,000 units/day and
`search.list` costs 100 units per call — 100 requests and the feature goes silent for
the rest of the day, mid-stream, with no warning. `videos.list` costs 1 unit, so
link-only requests are effectively unmetered. Searching also picks the top result,
which is frequently the wrong song and occasionally something we'd never want played
on a live.

Spotify's Web Playback SDK was rejected for needing Premium plus an OAuth flow, and
for being unreliable inside an OBS browser source. Playing local audio files was
rejected because it limits viewers to whatever the streamer prepared in advance.

## Consequences

Validation buys more than quota safety: `status.embeddable`, `contentDetails.duration`
and region restrictions are only knowable through the API, and all three fail silently
on stream if unchecked — an un-embeddable music video is just a black screen mid-live
with nothing explaining why.

The cost lands on viewers, who have to find and paste a link instead of typing a name.
That is a real drop in participation, especially on mobile, and it was accepted
deliberately.

Switching players later is expensive. The player widget, the validation step, the
request format, and every stored Filler song are all YouTube-shaped, so moving to
another source means rebuilding all four rather than swapping a backend.

One risk is unresolved: if TikTok mutes the stream for copyright, this decision fails
outright and local audio files become the only workable option.
