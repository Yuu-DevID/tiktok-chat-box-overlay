require('dotenv').config();
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { URL } = require('url');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'your_tiktok_username';
const WS_PORT = process.env.WS_PORT || 8081;
const HTTP_PORT = process.env.HTTP_PORT || 8080;
const MOCK_MODE = process.env.MOCK === '1';
const EASYDONATE_API_KEY = process.env.EASYDONATE_API_KEY || '';

// Self-hosted TTS engine (tts-engine-project, POST /v1/tts, {text, lang} ->
// streamed WAV). Switchable at runtime against the older Google proxy from
// the panel widget -- see ttsProvider below and the /tts route.
const TTS_ENGINE_URL = process.env.TTS_ENGINE_URL || 'http://127.0.0.1:8000/v1/tts';

// In-memory only, resets to 'google' on server restart -- same convention as
// timerState below. Switched via the panel's TTS provider control.
let ttsProvider = 'google'; // 'local' | 'google'

// Language spoken by TTS and sent to whichever provider is active, e.g. 'en'
// (default -- the overlay UI is English), 'id' or 'th'. Same in-memory,
// panel-controlled, WS-synced convention as ttsProvider above.
let ttsLang = 'en';
const TTS_LANGS = new Set(['en', 'id', 'th']);

// Global on/off for reading chat aloud, in-memory only (resets to true on
// restart). Was a per-browser localStorage toggle button on chat.html itself;
// moved here + broadcast over WS so it can be controlled from the Setup page
// instead, same pattern as ttsProvider above.
let ttsEnabled = true;

// TTS playback speed (1.0 = normal, >1 = faster, <1 = slower), same
// in-memory/broadcast convention as ttsProvider and ttsEnabled above.
let ttsSpeed = 1.5;

// Fraction of Comments (0..1) that TTS reads aloud after the skip filters;
// the rest are only shown. Lets a busy chat be read "sometimes" instead of
// queueing every line. Same in-memory/broadcast convention as above.
let ttsReadChance = 1;

// Whether the server currently has a live TikTok room connection (real mode)
// or is generating fake events (mock mode, always "connected"). Distinct from
// a browser's own WebSocket link to this server -- that can be open while
// TikTok itself is offline, which is exactly the case this flag exists to
// surface on the control room's LIVE badge.
let tiktokLiveConnected = MOCK_MODE;

// How many consecutive times connectToTikTok has failed since the last
// success; surfaced in tiktokConnectionPayload's detail so the control
// room's badge shows retry progress instead of a static offline message.
let tiktokReconnectAttempt = 0;

function tiktokConnectionPayload(detailOverride) {
  const payload = { type: 'tiktok-connection-state', connected: tiktokLiveConnected };
  if (!tiktokLiveConnected) {
    payload.detail =
      detailOverride ||
      (tiktokReconnectAttempt > 0
        ? `Reconnecting, attempt ${tiktokReconnectAttempt} (check that the account is live and the username is correct)`
        : undefined);
  }
  return payload;
}

// Proxies Google Translate's TTS endpoint so the chat widget can fetch audio
// same-origin (Chrome's ORB blocks the browser hitting translate.google.com
// directly). No API key needed. Kept as a fallback alongside the local
// engine; pick between them via ttsProvider.
function proxyGoogleTts(text, lang, res) {
  const ttsUrl =
    `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=` +
    encodeURIComponent(text.slice(0, 200));

  const req = https
    .get(
      ttsUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Referer: 'https://translate.google.com/',
        },
      },
      (googleRes) => {
        if (googleRes.statusCode !== 200) {
          res.writeHead(502);
          res.end('TTS upstream error');
          googleRes.resume();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        googleRes.pipe(res);
      }
    )
    .on('error', (err) => {
      console.error('Google TTS proxy error:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('TTS proxy failed');
    });

  // Without this, an upstream that accepts the connection but never sends a
  // response (or stalls mid-stream) leaves the client's <audio> element
  // waiting forever with no error/ended event -- the chat widget's TTS
  // queue then never advances and stays silent until the server restarts.
  req.setTimeout(15000, () => {
    req.destroy(new Error('TTS upstream timed out'));
  });
}

// Proxies the local TTS engine so the chat widget can fetch audio same-origin
// via a plain GET (the engine itself only accepts POST + a JSON body, which
// a browser <audio>/new Audio(url) element can't send).
function proxyLocalTts(text, lang, res) {
  const requestBody = JSON.stringify({ text, lang });
  const target = new URL(TTS_ENGINE_URL);

  const ttsReq = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    },
    (ttsRes) => {
      if (ttsRes.statusCode !== 200) {
        res.writeHead(502);
        res.end('TTS upstream error');
        ttsRes.resume();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      ttsRes.pipe(res);
    }
  );

  ttsReq.on('error', (err) => {
    console.error('TTS proxy error (is tts-engine-project running?):', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('TTS proxy failed');
  });

  // Same stall-protection as proxyGoogleTts above -- a hung local engine
  // would otherwise leave the client's TTS queue stuck silent forever.
  ttsReq.setTimeout(15000, () => {
    ttsReq.destroy(new Error('TTS engine timed out'));
  });

  ttsReq.write(requestBody);
  ttsReq.end();
}

// EasyDonate host isn't documented anywhere public -- overridable via env in
// case it turns out to differ once a real API key is available to test against.
const EASYDONATE_API_BASE_URL = process.env.EASYDONATE_API_BASE_URL || 'https://api.easydonate.app';

const MOCK_LEADERBOARD = [
  { name: 'sleeping', amount: 5428.15 },
  { name: 'kai_gamer', amount: 2040 },
  { name: 'pim.streamfan', amount: 1580.5 },
  { name: 'tanawat_th', amount: 990 },
  { name: 'user_888', amount: 720 },
  { name: 'nampeung_99', amount: 500 },
  { name: 'boss_888', amount: 350 },
  { name: 'malee_cat', amount: 220 },
  { name: 'lek_fc', amount: 150 },
  { name: 'skyfall', amount: 100 },
];

// Real donors who aren't tracked by the EasyDonate API but should still show
// up at the right rank -- kept in a gitignored file (not the repo) since it's
// this streamer's own donor data, not something to ship in source control.
const EXTRA_DONORS_FILE = process.env.EXTRA_DONORS_FILE || path.join(__dirname, 'extra-donors.json');

function loadExtraDonors() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EXTRA_DONORS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Spellings of one donor's name that should count as a single entry, e.g.
// { "Chi": "ชิ" } folds "Chi" into "ชิ". Matched case-insensitively. Gitignored
// for the same reason as extra-donors.json.
const DONOR_ALIASES_FILE = process.env.DONOR_ALIASES_FILE || path.join(__dirname, 'donor-aliases.json');

function loadDonorAliases() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DONOR_ALIASES_FILE, 'utf8'));
    const aliases = new Map();
    for (const [alias, name] of Object.entries(parsed || {})) {
      aliases.set(alias.trim().toLowerCase(), name);
    }
    return aliases;
  } catch {
    return new Map();
  }
}

function withExtraEntry(list) {
  const aliases = loadDonorAliases();
  const merged = new Map();
  for (const entry of [...list, ...loadExtraDonors()]) {
    const name = aliases.get(String(entry.name).trim().toLowerCase()) || String(entry.name).trim();
    // Case-insensitive key so "skyfall" and "Skyfall" sum into one entry,
    // shown with whichever spelling came first (the higher API amount).
    const key = name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.amount += Number(entry.amount) || 0;
    } else {
      merged.set(key, { name, amount: Number(entry.amount) || 0 });
    }
  }
  return [...merged.values()].sort((a, b) => b.amount - a.amount);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// In-memory only, by design (see CONTEXT.md non-goals) -- resets on server
// restart, no file/db persistence. gifters is keyed by uniqueId so a repeat
// donor's diamonds accumulate onto the same entry instead of splitting.
const stats = {
  comments: 0,
  gifts: 0,
  giftDiamonds: 0,
  viewers: new Set(),
  gifters: new Map(),
};

// Called from broadcast() so every chat/gift/member path -- mock and real
// alike -- updates the same counters without each call site remembering to.
function trackStats(message) {
  if (message.type === 'chat' || message.type === 'emote') {
    stats.comments++;
    if (message.user) stats.viewers.add(message.user);
  } else if (message.type === 'gift') {
    stats.gifts += message.repeatCount || 1;
    stats.giftDiamonds += message.diamondCount || 0;
    if (message.user) {
      const gifter = stats.gifters.get(message.user) || { nickname: message.nickname, diamonds: 0 };
      gifter.nickname = message.nickname;
      gifter.diamonds += message.diamondCount || 0;
      stats.gifters.set(message.user, gifter);
    }
  } else if (message.type === 'member') {
    if (message.user) stats.viewers.add(message.user);
  }
}

function buildSummaryPayload() {
  const topGifter = [...stats.gifters.values()].sort((a, b) => b.diamonds - a.diamonds)[0] || null;
  return {
    type: 'summary',
    comments: stats.comments,
    gifts: stats.gifts,
    giftDiamonds: stats.giftDiamonds,
    viewers: stats.viewers.size,
    topGifter,
  };
}

// ---------------------------------------------------------------------------
// Profanity filter: a matching Comment is dropped entirely -- not shown on the
// chat overlay, not read by TTS. Targets "ควย" and its dodge spellings
// (ขวย, ข็วย, ฆวย, ฆวษ์ย, ค ว ย, ค.ว.ย, ควววย ...) and "หี" with its
// dodges (หิ๋, หี่, แหย่หิ ...).
// ---------------------------------------------------------------------------

// Spaces, zero-width chars and punctuation people wedge between letters.
const PROFANITY_SEPARATORS = /[\s​-‍﻿.,\-_*~!?'"`|/\\+=:;()[\]{}<>^]+/g;
// [คขฆฅ] + ว + optional silent letter (ษ์, ส์ ...) + ย, with stray tone
// marks / ็ / ์ allowed around ว (ข็วย, ค่วย, คว์ย);
// or หี / หิ + tone mark (หิ๋) not followed by a consonant (keeps หีบ, หิ้ว);
// or แหย่ + หิ/หี in any form;
// or เงี่ยน with a silent ห / swapped tone (เหงี้ยน) -- tone mark required so
// the name เหงียน (Nguyen) still passes;
// or น้ำแตก and its misspellings (น้ามแตค);
// or ควย with ย swapped for a silent letter (ซวษ์, ขวษ์) -- plain ซวย stays allowed;
// or อม + ควย/ซวย;
// or หี spelled with a wedged silent letter (ฮฐ์ี, อฐ์ี, หฐ์ี), or with the
// vowel dropped (หด์);
// or ตูด spelled with ฏ (ตูฏ, ฏูด), or เลีย/เรีย + ตูด;
// or จับนม, or นม with a stray ์ (นม์).
const PROFANITY_PATTERN =
  /[คขฆฅ][็่-๋]*ว[็่-์]*(?:[ก-ฮ]์)?ย|ห(?:ี[่-๋]?|ิ[่-๋])(?![ก-ฮ])|แหย่ห[ิี]|เห?งี[่-๋]ยน|น้[ำา]ม?แต[กค]|[คขฆฅซ][็่-๋]*ว[็่-๋]*[ก-ฮ]์|อม[คขฆฅซ][็่-๋]*ว[็่-๋]*ย|[หฮอ][ก-ฮ]์[ิี]|ห[ก-ฮ]์|ฏู[ดฏ]|[ตฏ]ูฏ|เ[ลร]ีย[ตฏ]ู[ดฏ]|จับนม|นม์/;
// Real words that contain the pattern and must not be blocked.
const PROFANITY_ALLOWED = /ขวยเขิน|เขินขวย/g;
// Gujarati letters look like Thai (ખૂઐ ~ ขวย, યેત્ ~ เย็ด) and get used to
// spell profanity past the Thai patterns; no real viewer chats in Gujarati.
const PROFANITY_LOOKALIKE_SCRIPT = /[઀-૿]/;

function isProfaneComment(text) {
  if (PROFANITY_LOOKALIKE_SCRIPT.test(String(text || ''))) return true;
  const normalized = String(text || '')
    .replace(PROFANITY_SEPARATORS, '')
    .replace(/(.)\1+/g, '$1')
    .replace(PROFANITY_ALLOWED, '');
  return PROFANITY_PATTERN.test(normalized);
}


// ---------------------------------------------------------------------------
// Song requests (see docs/adr/0001-youtube-link-only-song-requests.md)
//
// A Song request is a YouTube link, never a title we search for -- search.list
// costs 100 quota units against a 10,000/day budget, which would silence the
// feature after ~100 requests mid-stream. videos.list costs 1, so link-only is
// effectively unmetered. The API key is required rather than optional: without
// it the feature is off, instead of running blind.
// ---------------------------------------------------------------------------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_REGION = process.env.YOUTUBE_REGION || 'TH';
const SONG_MAX_DURATION_SEC = Number(process.env.SONG_MAX_DURATION_SEC || 600);
// Overridable so the test harness can point at a scratch file -- otherwise
// running the tests would overwrite the streamer's real curated Filler songs.
const FILLER_SONGS_FILE = process.env.FILLER_SONGS_FILE || path.join(__dirname, 'filler-songs.json');

// How many just-played videos stay un-requestable, so the same track cannot
// bounce straight back into the queue the moment it ends.
const RECENT_VIDEO_MEMORY = 20;

const YOUTUBE_LINK_PATTERNS = [
  /youtube\.com\/watch\?(?:[^\s]*&)?v=([A-Za-z0-9_-]{11})/i,
  /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i,
  /youtube\.com\/live\/([A-Za-z0-9_-]{11})/i,
  /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i,
];

// A request has to be opted into with the command word. Without it every
// link anyone happens to paste in chat -- a clip they are talking about, a
// reply to someone else -- lands in the streamer's approval queue as noise.
// `m!p` is the short form viewers are told to use; `/music` stays accepted so
// older chat messages and existing docs keep working.
const SONG_COMMAND = /^\s*(?:m!p|\/music)(?:\s+|$)/i;
const SONG_QUERY_MAX_LENGTH = 120;

// What someone asked for: a YouTube link, or just a song name to search for.
// Returns null when the Comment doesn't start with the command at all.
function parseSongCommand(text) {
  const match = SONG_COMMAND.exec(text || '');
  if (!match) return null;
  return text.slice(match[0].length).trim();
}

function extractVideoId(text) {
  for (const pattern of YOUTUBE_LINK_PATTERNS) {
    const match = pattern.exec(String(text || ''));
    if (match) return match[1];
  }
  return null;
}

// A browser-ish UA plus the consent cookies: without them YouTube answers a
// datacenter/EEA request with the consent interstitial instead of results.
const YOUTUBE_SEARCH_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function httpsGetText(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': YOUTUBE_SEARCH_UA,
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI',
        },
      },
      (apiRes) => {
        const status = apiRes.statusCode;
        if (status >= 300 && status < 400 && apiRes.headers.location && redirectsLeft > 0) {
          apiRes.resume();
          const next = new URL(apiRes.headers.location, url).toString();
          httpsGetText(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        let body = '';
        apiRes.on('data', (chunk) => (body += chunk));
        apiRes.on('end', () => {
          if (status !== 200) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('YouTube search timed out')));
    req.on('error', reject);
  });
}

function isLiveResult(videoRenderer) {
  const badges = Array.isArray(videoRenderer.badges) ? videoRenderer.badges : [];
  return badges.some((badge) => /LIVE/i.test((badge && badge.metadataBadgeRenderer && badge.metadataBadgeRenderer.label) || ''));
}

function hasDurationLabel(videoRenderer) {
  const length = videoRenderer.lengthText;
  return Boolean(length && (length.simpleText || (length.runs && length.runs.length)));
}

// Depth-first walk of ytInitialData collecting playable video entries. Two
// shapes are in the wild: the classic videoRenderer and the newer
// lockupViewModel used by some result layouts. Live streams are skipped when
// any recorded result exists (a live stream can never be played from the
// queue), and several ids are kept so a top hit that blocks embedding or is
// too long can still fall through to the next playable result.
function collectVideoIds(node, out = [], options = {}, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40 || out.length >= 8) return out;
  const videoRenderer = node.videoRenderer;
  if (videoRenderer && /^[\w-]{11}$/.test(videoRenderer.videoId || '')) {
    const playable = options.allowLive || (!isLiveResult(videoRenderer) && hasDurationLabel(videoRenderer));
    if (playable && !out.includes(videoRenderer.videoId)) out.push(videoRenderer.videoId);
  }
  const lockup = node.lockupViewModel;
  if (
    lockup &&
    lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' &&
    /^[\w-]{11}$/.test(lockup.contentId || '') &&
    !out.includes(lockup.contentId)
  ) {
    out.push(lockup.contentId);
  }
  for (const key of Object.keys(node)) {
    collectVideoIds(node[key], out, options, depth + 1);
    if (out.length >= 8) break;
  }
  return out;
}

function extractVideoIdsFromHtml(html) {
  const marker = /(?:var\s+)?ytInitialData\s*=\s*/.exec(html || '');
  if (!marker) return [];
  // The JSON blob runs until the script tag that carries it; trimming back to
  // the matching brace is safer than trusting the first `;</script>` because
  // YouTube has shipped both endings over time.
  const start = marker.index + marker[0].length;
  const end = html.indexOf('</script>', start);
  if (end === -1) return [];
  let blob = html.slice(start, end).trim();
  if (blob.endsWith(';')) blob = blob.slice(0, -1);
  let data;
  try {
    data = JSON.parse(blob);
  } catch {
    return [];
  }
  const recorded = collectVideoIds(data);
  // A query can genuinely be all live results; in that case keep them so the
  // refusal reason says "live stream" instead of "no result".
  return recorded.length ? recorded : collectVideoIds(data, [], { allowLive: true });
}

// Resolves a song name to candidate video ids without spending Data API quota:
// search.list costs 100 units against a 10,000/day budget (100 searches and
// the feature is silent for the rest of the day), while scraping the public
// results page costs nothing. The API's search.list is only a fallback for
// when YouTube changes its markup, and is logged when it happens.
async function searchYouTubeSong(query) {
  const url =
    'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(query) +
    '&hl=en&gl=US&sp=EgIQAQ%253D%253D'; // sp = filter: videos only

  try {
    const html = await httpsGetText(url);
    const videoIds = extractVideoIdsFromHtml(html);
    if (videoIds.length) {
      console.log(`[song] search "${query}" -> ${videoIds.length} candidate(s), first ${videoIds[0]}`);
      return { ok: true, videoIds };
    }
    console.warn('[song] search page had no parseable result, falling back to Data API');
  } catch (err) {
    console.warn(`[song] search page failed (${err.message}), falling back to Data API`);
  }

  if (!YOUTUBE_API_KEY) return { ok: false, reason: 'No search result for that name' };
  try {
    const payload = await fetchJson(
      'https://www.googleapis.com/youtube/v3/search' +
        `?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}` +
        `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
    );
    const videoIds = (payload.items || [])
      .map((item) => item && item.id && item.id.videoId)
      .filter(Boolean);
    if (videoIds.length) {
      console.log(`[song] search "${query}" -> ${videoIds.length} candidate(s) (Data API)`);
      return { ok: true, videoIds };
    }
  } catch (err) {
    console.error(`[song] Data API search failed: ${err.message}`);
  }
  return { ok: false, reason: 'No search result for that name' };
}

// ISO 8601 durations, which is the only format the API reports ("PT4M13S").
// The whole time section is optional: an in-progress live stream reports "P0D",
// which has to parse as 0 so it is refused as a live stream rather than as an
// unreadable duration.
function parseIsoDuration(iso) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!match) return null;
  const [, d, h, m, sec] = match.map((v) => (v === undefined ? 0 : Number(v)));
  return d * 86400 + h * 3600 + m * 60 + sec;
}

// The three things only videos.list can tell us -- embeddable, length and
// region -- all fail *silently* on stream if unchecked: the player just shows a
// black rectangle mid-live with nothing explaining why. Checking here means a
// bad link is refused at request time instead of surfacing 40 minutes later.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (apiRes) => {
        let body = '';
        apiRes.on('data', (chunk) => (body += chunk));
        apiRes.on('end', () => {
          if (apiRes.statusCode !== 200) {
            reject(new Error(`HTTP ${apiRes.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function fetchVideoDetails(videoId) {
  const url =
    'https://www.googleapis.com/youtube/v3/videos' +
    `?part=snippet,contentDetails,status&id=${encodeURIComponent(videoId)}` +
    `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  return fetchJson(url).catch((err) => {
    throw new Error(`YouTube API ${err.message}`);
  });
}

// Returns { ok: true, song } or { ok: false, reason }. The reason is for the
// server log and the panel only -- a refusal is never sent back to the asker,
// since the room chat is read-only to us (see CONTEXT.md).
async function validateVideo(videoId) {
  const payload = await fetchVideoDetails(videoId);
  const item = payload.items && payload.items[0];
  if (!item) return { ok: false, reason: 'Video not found (deleted or private)' };

  if (item.status && item.status.embeddable === false) {
    return { ok: false, reason: 'The owner disabled embedding' };
  }

  const durationSec = parseIsoDuration(item.contentDetails && item.contentDetails.duration);
  if (durationSec === null) return { ok: false, reason: 'Could not read the video length' };
  if (durationSec === 0) return { ok: false, reason: 'That is a live stream, not a video' };
  if (durationSec > SONG_MAX_DURATION_SEC) {
    return { ok: false, reason: `Longer than ${Math.round(SONG_MAX_DURATION_SEC / 60)} minutes` };
  }

  const restriction = item.contentDetails && item.contentDetails.regionRestriction;
  if (restriction && restriction.blocked && restriction.blocked.includes(YOUTUBE_REGION)) {
    return { ok: false, reason: `Blocked in region ${YOUTUBE_REGION}` };
  }
  if (restriction && restriction.allowed && !restriction.allowed.includes(YOUTUBE_REGION)) {
    return { ok: false, reason: `Blocked in region ${YOUTUBE_REGION}` };
  }

  return {
    ok: true,
    song: {
      videoId,
      title: (item.snippet && item.snippet.title) || videoId,
      channel: (item.snippet && item.snippet.channelTitle) || '',
      durationSec,
    },
  };
}

// Filler songs are the one piece of song state written to disk. A viewer
// request is worth minutes and is trivially re-made; a Filler song is something
// the streamer curated and would resent rebuilding every stream.
function loadFillerSongs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILLER_SONGS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let fillerSongs = loadFillerSongs();

function saveFillerSongs() {
  fs.writeFile(FILLER_SONGS_FILE, JSON.stringify(fillerSongs, null, 2), (err) => {
    if (err) console.error('Failed to save filler-songs.json:', err.message);
  });
}

// In-memory, deliberately: an approval given three hours ago was given in a
// moment that no longer exists, so a restart drops the queue rather than
// resuming it. Only fillerSongs above survives.
const songState = {
  // On by default when an API key is configured: `m!p` should just work after
  // setup, and the chat window's Requests switch is still there to turn it off.
  enabled: Boolean(YOUTUBE_API_KEY),
  pending: [], // awaiting the streamer's approval
  approved: [], // approved, waiting their turn
  nowPlaying: null,
  recentVideoIds: [],
  // When on, a request that passes validation is approved and started by the
  // same message -- which is what makes `m!p <song>` feel like a jukebox
  // instead of a moderation queue. Off restores one-by-one approval; requests
  // always pass through the same validation either way.
  autoApprove: true,
};

let songSeq = 0;
function nextSongId() {
  songSeq += 1;
  return `s${Date.now().toString(36)}-${songSeq}`;
}

function songStatePayload() {
  return {
    type: 'song-state',
    enabled: songState.enabled,
    autoApprove: songState.autoApprove,
    hasApiKey: Boolean(YOUTUBE_API_KEY),
    pending: songState.pending,
    approved: songState.approved,
    nowPlaying: songState.nowPlaying,
    fillers: fillerSongs,
    maxDurationSec: SONG_MAX_DURATION_SEC,
    command: 'm!p',
  };
}

// Streamer-facing only: tells the panel/chatbox what just happened to a
// request, since the room chat is read-only to us and the asker can't be
// answered in TikTok. Never shown on any OBS overlay.
function notifySongRequest(notice) {
  broadcast({ type: 'song-request-notice', at: Date.now(), ...notice });
}

function isVideoTaken(videoId) {
  return (
    songState.pending.some((s) => s.videoId === videoId) ||
    songState.approved.some((s) => s.videoId === videoId) ||
    (songState.nowPlaying && songState.nowPlaying.videoId === videoId) ||
    songState.recentVideoIds.includes(videoId)
  );
}

// Round-robin over the fillers so a long dry spell does not replay the same one.
let fillerCursor = 0;
function nextFillerSong() {
  if (fillerSongs.length === 0) return null;
  const filler = fillerSongs[fillerCursor % fillerSongs.length];
  fillerCursor += 1;
  return { ...filler, id: nextSongId(), isFiller: true, nickname: null };
}

// An approved viewer request always wins over a Filler song; playing a viewer
// request consumes it, playing a Filler song does not.
function advanceSong() {
  const next = songState.approved.shift() || nextFillerSong();
  songState.nowPlaying = next || null;
  if (next) {
    songState.recentVideoIds.push(next.videoId);
    while (songState.recentVideoIds.length > RECENT_VIDEO_MEMORY) {
      songState.recentVideoIds.shift();
    }
  }
  broadcast(songStatePayload());
}

// Called from the CHAT handler for every Comment. Everything here is silent to
// the asker by design -- the panel notice is for the streamer, and the room
// chat is read-only to us.
async function handleSongRequestComment(user, nickname, comment) {
  if (!songState.enabled || !YOUTUBE_API_KEY) return;

  const query = parseSongCommand(comment);
  if (!query) {
    notifySongRequest({ ok: false, nickname, query, reason: 'Add a song name or link after m!p' });
    return;
  }

  if (query.length > SONG_QUERY_MAX_LENGTH) {
    notifySongRequest({ ok: false, nickname, query, reason: 'That name is too long' });
    return;
  }
  if (hasViewerRequest(user)) {
    console.log(`[song] dropped ${nickname}: already has one request waiting`);
    notifySongRequest({ ok: false, nickname, query, reason: 'You already have a request waiting' });
    return;
  }

  try {
    const resolved = await resolveRequestSong(query);
    if (!resolved.ok) {
      console.log(`[song] refused ${nickname} ("${query}"): ${resolved.reason}`);
      notifySongRequest({ ok: false, nickname, query, reason: resolved.reason });
      return;
    }

    // Re-checked after the search/lookup awaits: another Comment from the same
    // viewer may have landed in the meantime.
    if (hasViewerRequest(user)) return;

    const song = {
      ...resolved.song,
      id: nextSongId(),
      user,
      nickname,
      isFiller: false,
      requestedAt: Date.now(),
    };

    if (songState.autoApprove) {
      songState.approved.push(song);
      console.log(`[song] auto-approved "${song.title}" from ${nickname}`);
      if (!songState.nowPlaying) {
        advanceSong();
      } else {
        broadcast(songStatePayload());
      }
      notifySongRequest({ ok: true, nickname, query, title: song.title, auto: true });
    } else {
      songState.pending.push(song);
      console.log(`[song] queued "${song.title}" from ${nickname}`);
      broadcast(songStatePayload());
      notifySongRequest({ ok: true, nickname, query, title: song.title, auto: false });
    }
  } catch (err) {
    console.error(`[song] request from ${nickname} failed:`, err.message);
    notifySongRequest({ ok: false, nickname, query, reason: 'Could not look that up' });
  }
}

function hasViewerRequest(user) {
  return [...songState.pending, ...songState.approved].some((s) => s.user === user);
}

// Turns a command's argument into a validated, playable song. A link is used as
// given; a name goes through search and then each candidate in order, so a top
// hit that is a live stream or blocks embedding doesn't refuse the whole
// request. Returns { ok: true, song } or { ok: false, reason }.
async function resolveRequestSong(query) {
  const directId = extractVideoId(query);
  let candidates;
  if (directId) {
    candidates = [directId];
  } else {
    const search = await searchYouTubeSong(query);
    if (!search.ok) return search;
    candidates = search.videoIds;
  }

  let lastReason = 'No playable result for that name';
  for (const videoId of candidates) {
    if (isVideoTaken(videoId)) {
      lastReason = 'That video is already queued or just played';
      continue;
    }
    const result = await validateVideo(videoId);
    if (!result.ok) {
      console.log(`[song] skipped ${videoId}: ${result.reason}`);
      lastReason = result.reason;
      continue;
    }
    return { ok: true, song: result.song };
  }
  return { ok: false, reason: lastReason };
}

// The streamer's own requests take the same path through validateVideo as a
// viewer's -- same checks, same refusals -- and differ only in where they land.
// A link or a song name is accepted here too, so Filler entries can be added in
// whichever form is at hand.
async function addFillerSong(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, reason: 'Enter a YouTube link or a song name' };
  if (raw.length > SONG_QUERY_MAX_LENGTH) return { ok: false, reason: 'That name is too long' };

  const resolved = await resolveRequestSong(raw);
  if (!resolved.ok) return resolved;

  const song = resolved.song;
  if (fillerSongs.some((f) => f.videoId === song.videoId)) {
    return { ok: false, reason: 'That song is already a Filler' };
  }

  fillerSongs.push({ ...song, id: nextSongId() });
  saveFillerSongs();
  broadcast(songStatePayload());
  return { ok: true };
}

// Proxied (not called directly from the browser) so the EasyDonate API key
// never ships to the client. Falls back to mock data when no key is
// configured, so the /top-donate widget works out of the box.
// EasyDonate's leaderboard widget endpoint only returns as many donors as the
// widget's dashboard "count" setting (5 by default) and keys them by exact
// name, so "Skyfall" and "skyfall" split and anyone past rank 5 is lost.
// Building the board from the full donation history instead gives every donor,
// which withExtraEntry then merges by name/alias.
const DONATIONS_PAGE_SIZE = 100;

function easyDonateGet(apiPath) {
  return new Promise((resolve, reject) => {
    https
      .get(
        `${EASYDONATE_API_BASE_URL}${apiPath}`,
        { headers: { Authorization: `Bearer ${EASYDONATE_API_KEY}` } },
        (apiRes) => {
          let body = '';
          apiRes.on('data', (chunk) => (body += chunk));
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              reject(new Error(`EasyDonate ${apiPath} returned ${apiRes.statusCode}: ${body}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`EasyDonate ${apiPath} parse error: ${err.message}`));
            }
          });
        }
      )
      .on('error', reject);
  });
}

async function fetchDonationTotals() {
  const donations = [];
  for (let page = 1, totalPage = 1; page <= totalPage; page++) {
    const { data } = await easyDonateGet(`/api/v1/donations?size=${DONATIONS_PAGE_SIZE}&page=${page}`);
    totalPage = data?.totalPage || 1;
    donations.push(...(data?.histories || []));
  }
  return donations
    .filter((donation) => donation.status === 'SUCCESS')
    .map((donation) => ({ name: donation.donatorName || 'Anonymous', amount: Number(donation.amount) || 0 }));
}

async function handleLeaderboard(req, res) {
  if (!EASYDONATE_API_KEY) {
    sendJson(res, 200, { leaderboard: withExtraEntry(MOCK_LEADERBOARD), mock: true });
    return;
  }

  try {
    const leaderboard = withExtraEntry(await fetchDonationTotals());
    sendJson(res, 200, { leaderboard, mock: false });
  } catch (err) {
    console.error('EasyDonate leaderboard error:', err.message);
    sendJson(res, 502, { error: 'EasyDonate request failed' });
  }
}

const DEFAULT_TIKTOK_LIVE_PY = process.env.TIKTOK_LIVE_PY || '/home/yusuf/Downloads/tiktok_live.py';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function runTiktokLive(scriptPath, args) {
  return new Promise((resolve) => {
    const child = spawn('python3', [scriptPath, ...args], {
      cwd: path.dirname(scriptPath),
      env: process.env,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr, scriptPath }));
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout: '', stderr: err.message, scriptPath }));
  });
}

async function handleTiktokLive(req, res, reqUrl) {
  if (reqUrl.pathname === '/api/tiktok-live/status') {
    const scriptPath = reqUrl.searchParams.get('script') || DEFAULT_TIKTOK_LIVE_PY;
    const exists = fs.existsSync(scriptPath);
    sendJson(res, 200, { available: exists, path: scriptPath, defaultPath: DEFAULT_TIKTOK_LIVE_PY });
    return true;
  }
  if (reqUrl.pathname === '/api/tiktok-live/create' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const scriptPath = body.scriptPath || DEFAULT_TIKTOK_LIVE_PY;
      const cookies = body.cookiesPath || path.join(path.dirname(scriptPath), 'www.tiktok.com.cookies.json');
      const args = ['create', '--cookies', cookies];
      if (body.title) args.push('--title', String(body.title));
      if (body.topic) args.push('--topic', String(body.topic));
      if (body.region) args.push('--region', String(body.region));
      if (body.timezone) args.push('--timezone', String(body.timezone));
      if (body.output) args.push('--output', String(body.output));
      if (body.replay) args.push('--replay');
      if (body.ageRestricted) args.push('--age-restricted');
      const result = await runTiktokLive(scriptPath, args);
      broadcast({ type: 'tiktok-live-result', action: 'create', ...result });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }
  if (reqUrl.pathname === '/api/tiktok-live/end' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const scriptPath = body.scriptPath || DEFAULT_TIKTOK_LIVE_PY;
      const cookies = body.cookiesPath || path.join(path.dirname(scriptPath), 'www.tiktok.com.cookies.json');
      const result = await runTiktokLive(scriptPath, ['end', '--cookies', cookies]);
      broadcast({ type: 'tiktok-live-result', action: 'end', ...result });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }
  return false;
}

// Serves each overlay widget's page (see PAGE_ROUTES below) plus static
// assets, so each one can be added as its own Browser Source in OBS/Streamlabs
const httpServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${HTTP_PORT}`);

  if (reqUrl.pathname === '/api/leaderboard') {
    handleLeaderboard(req, res);
    return;
  }

  if (reqUrl.pathname.startsWith('/api/tiktok-live/')) {
    handleTiktokLive(req, res, reqUrl).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  // Opens the standalone desktop chat window (bin/chatbox-window.sh) from the
  // control room. Loopback-only on purpose: it spawns a local process, so it
  // must not be triggerable from another device on the LAN.
  if (reqUrl.pathname === '/api/open-window') {
    const remote = req.socket.remoteAddress || '';
    const isLoopback =
      remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
    if (!isLoopback) {
      res.writeHead(403);
      res.end('Loopback only');
      return;
    }
    const script = path.join(__dirname, 'bin', 'chatbox-window.sh');
    if (!fs.existsSync(script)) {
      res.writeHead(500);
      res.end('Launcher script missing');
      return;
    }
    try {
      spawn('bash', [script], { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('Failed to open chat window:', err.message);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (reqUrl.pathname === '/tts') {
    const text = reqUrl.searchParams.get('text') || '';
    if (!text) {
      res.writeHead(400);
      res.end('Missing text param');
      return;
    }
    if (ttsProvider === 'google') {
      proxyGoogleTts(text, ttsLang, res);
    } else {
      proxyLocalTts(text, ttsLang, res);
    }
    return;
  }

  // Serve the bundled Kanit font files so the overlay renders Thai text
  // consistently without depending on system fonts.
  if (reqUrl.pathname.startsWith('/fonts/') && reqUrl.pathname.endsWith('.ttf')) {
    const fontFile = path.basename(reqUrl.pathname);
    const fontPath = path.join(__dirname, 'fonts', fontFile);
    fs.readFile(fontPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Font not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'font/ttf' });
      res.end(data);
    });
    return;
  }

  // Serve canvas-confetti from node_modules instead of a CDN so the overlay
  // works fully offline / without external requests.
  if (reqUrl.pathname === '/vendor/confetti.js') {
    const confettiPath = path.join(__dirname, 'node_modules', 'canvas-confetti', 'dist', 'confetti.browser.js');
    fs.readFile(confettiPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Failed to load confetti.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
    return;
  }

  // Generic static serve for the split widget files. Each widget lives in its
  // own folder (widgets/chat/chat.html, chat.css, chat.js, ...) alongside a
  // shared/ folder for code common to all of them, so this resolves the full
  // path under widgets/ rather than just the basename.
  const WIDGET_CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  if (reqUrl.pathname.startsWith('/api/tiktok-live/')) {
    handleTiktokLive(req, res, reqUrl).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  if (reqUrl.pathname.startsWith('/widgets/')) {
    const ext = path.extname(reqUrl.pathname);
    const contentType = WIDGET_CONTENT_TYPES[ext];
    if (!contentType) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // path.join collapses ".." segments, and this check rejects anything
    // that still climbs outside widgets/ afterwards -- prevents requests
    // like /widgets/../server.js from escaping the widgets folder.
    const widgetsRoot = path.join(__dirname, 'widgets');
    const widgetPath = path.join(widgetsRoot, decodeURIComponent(reqUrl.pathname.slice('/widgets/'.length)));
    if (!widgetPath.startsWith(widgetsRoot + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(widgetPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Widget file not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return;
  }

  // Each split overlay widget lives at its own path so it can be added as a
  // separate Browser Source in OBS/Streamlabs and scaled/positioned independently.
  const PAGE_ROUTES = {
    '/': 'index.html',
    '/chat': 'widgets/chat/chat.html',
    '/pinned': 'widgets/pinned/pinned.html',
    '/panel': 'widgets/panel/panel.html',
    '/top-donate': 'widgets/top-donate/top-donate.html',
    '/summary': 'widgets/summary/summary.html',
    '/timer': 'widgets/timer/timer.html',
    '/music': 'widgets/music/music.html',
    '/follow': 'widgets/follow/follow.html',
    '/chatbox': 'widgets/chatbox/chatbox.html',
  };
  const page = PAGE_ROUTES[reqUrl.pathname];
  if (!page) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(__dirname, page), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Failed to load page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});
httpServer.listen(HTTP_PORT, () => {
  console.log(`Overlay page: http://localhost:${HTTP_PORT}`);
});

// Broadcast chat events to any connected overlay pages
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

// Live log: one JSON object per line in logs/live-YYYY-MM-DD.jsonl, written
// for the whole session so a "my comment never showed up" report can be
// traced after the fact. Each comment can be followed through three stages:
//   tiktok-raw  -- what arrived on TikTok's websocket (before the connector
//                  decides what to do with it)
//   broadcast   -- what the server sent to overlays, with a `logId`
//   overlay     -- what an overlay page reports it actually rendered (same `logId`)
// A comment missing from tiktok-raw never reached us at all.
const LIVE_LOG_DIR = path.join(__dirname, 'logs');
let liveLogStream = null;
let liveLogDate = null;

function liveLog(stage, data) {
  const now = new Date();
  // Local date, not UTC, so one evening's stream lands in one file.
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  try {
    if (date !== liveLogDate) {
      if (liveLogStream) liveLogStream.end();
      fs.mkdirSync(LIVE_LOG_DIR, { recursive: true });
      liveLogStream = fs.createWriteStream(path.join(LIVE_LOG_DIR, `live-${date}.jsonl`), { flags: 'a' });
      liveLogStream.on('error', (err) => console.error('[live-log] write failed:', err.message));
      liveLogDate = date;
    }
    liveLogStream.write(JSON.stringify({ t: now.toISOString(), stage, ...data }) + '\n');
  } catch (err) {
    console.error('[live-log] failed:', err.message);
  }
}

// Only these reach the log from broadcast(); state syncs (timer, songs, tts
// settings) are resent constantly and say nothing about missing comments.
const LOGGED_BROADCAST_TYPES = new Set(['chat', 'emote', 'gift']);
let nextLogId = 1;

function broadcast(payload) {
  trackStats(payload);
  let delivered = 0;
  if (LOGGED_BROADCAST_TYPES.has(payload.type)) {
    payload = { ...payload, logId: nextLogId++ };
  }
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
      delivered++;
    }
  });
  if (payload.logId) {
    liveLog('broadcast', {
      logId: payload.logId,
      type: payload.type,
      user: payload.user,
      nickname: payload.nickname,
      comment: payload.comment,
      giftName: payload.giftName,
      emoteCount: payload.emoteImages?.length,
      clients: delivered,
    });
  }
}

// In-memory only, same as `stats` -- resets on server restart. `endsAt` (not
// a countdown value) is the source of truth while running so every client
// computes its own remaining time from `endsAt - Date.now()` instead of the
// server pushing a tick every second.
const timerState = {
  status: 'idle', // idle | running | paused | ended
  durationMs: 5 * 60000,
  endsAt: null,
  remainingMs: null,
  message: 'Be right back — grab a drink and stay tuned!',
};

function timerStatePayload() {
  return { type: 'timer-state', ...timerState };
}

// Single authoritative running -> ended transition, checked here instead of
// leaving every open /timer browser source to independently decide it hit
// zero (they'd all fire around the same time but not necessarily agree).
setInterval(() => {
  if (timerState.status === 'running' && Date.now() >= timerState.endsAt) {
    timerState.status = 'ended';
    timerState.endsAt = null;
    broadcast(timerStatePayload());
  }
}, 250);

// The panel widget sends messages upstream: pin/unpin a comment, request the
// current session stats snapshot to show on /summary, or control the BRB timer.
let nextClientId = 1;

wss.on('connection', (ws) => {
  const clientId = nextClientId++;
  liveLog('ws-client', { clientId, event: 'connected', total: wss.clients.size });
  ws.on('close', () => liveLog('ws-client', { clientId, event: 'closed', total: wss.clients.size }));

  // Sync-on-connect: without this, reloading /timer mid-countdown (or opening
  // /panel late) would show idle/zero until the next control action instead
  // of picking up wherever the countdown actually is.
  ws.send(JSON.stringify(timerStatePayload()));
  ws.send(JSON.stringify({ type: 'tts-provider-state', provider: ttsProvider }));
  ws.send(JSON.stringify({ type: 'tts-lang-state', lang: ttsLang }));
  ws.send(JSON.stringify({ type: 'tts-enabled-state', enabled: ttsEnabled }));
  ws.send(JSON.stringify({ type: 'tts-speed-state', speed: ttsSpeed }));
  ws.send(JSON.stringify({ type: 'tts-read-chance-state', chance: ttsReadChance }));
  ws.send(JSON.stringify(tiktokConnectionPayload()));
  ws.send(JSON.stringify(songStatePayload()));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'overlay-log') {
      // Reports from overlay pages (rendered / handler error / page hello);
      // logged only, never rebroadcast.
      const { type, ...report } = message;
      liveLog('overlay', { clientId, ...report });
    } else if (message.type === 'pin' || message.type === 'unpin') {
      broadcast(message);
    } else if (message.type === 'show-summary') {
      broadcast(buildSummaryPayload());
    } else if (message.type === 'timer-start') {
      timerState.durationMs = message.durationMs;
      timerState.endsAt = Date.now() + message.durationMs;
      timerState.remainingMs = null;
      timerState.status = 'running';
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-pause') {
      if (timerState.status !== 'running') return;
      timerState.remainingMs = timerState.endsAt - Date.now();
      timerState.endsAt = null;
      timerState.status = 'paused';
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-resume') {
      if (timerState.status !== 'paused') return;
      timerState.endsAt = Date.now() + timerState.remainingMs;
      timerState.remainingMs = null;
      timerState.status = 'running';
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-reset') {
      timerState.status = 'idle';
      timerState.endsAt = null;
      timerState.remainingMs = null;
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-set-message') {
      timerState.message = message.message;
      broadcast(timerStatePayload());
    } else if (message.type === 'set-song-enabled') {
      songState.enabled = !!message.enabled;
      // Turning the feature off clears what is waiting but leaves whatever is
      // playing alone -- cutting the audio mid-track would be the more
      // surprising behaviour of the two.
      if (!songState.enabled) {
        songState.pending = [];
        songState.approved = [];
      }
      broadcast(songStatePayload());
    } else if (message.type === 'set-song-auto-approve') {
      songState.autoApprove = !!message.enabled;
      // Flipping it on drains anything already waiting for approval into the
      // queue (and starts the first one if nothing is playing), so the switch
      // isn't only about requests that arrive after it.
      if (songState.autoApprove && songState.pending.length) {
        songState.approved.push(...songState.pending);
        songState.pending = [];
        if (!songState.nowPlaying) {
          advanceSong();
          return;
        }
      }
      broadcast(songStatePayload());
    } else if (message.type === 'song-approve') {
      const index = songState.pending.findIndex((s) => s.id === message.id);
      if (index === -1) return;
      const [song] = songState.pending.splice(index, 1);
      songState.approved.push(song);
      // Nothing playing means this one starts now rather than waiting for an
      // end-of-song event that will never arrive.
      if (!songState.nowPlaying) {
        advanceSong();
      } else {
        broadcast(songStatePayload());
      }
    } else if (message.type === 'song-reject') {
      // Covers both lists: the panel offers the same remove button on a song
      // waiting for approval and on one already approved but not yet played.
      const pendingIndex = songState.pending.findIndex((s) => s.id === message.id);
      if (pendingIndex !== -1) {
        songState.pending.splice(pendingIndex, 1);
      } else {
        const approvedIndex = songState.approved.findIndex((s) => s.id === message.id);
        if (approvedIndex === -1) return;
        songState.approved.splice(approvedIndex, 1);
      }
      broadcast(songStatePayload());
    } else if (message.type === 'song-start') {
      // Distinct from song-skip even though both land on advanceSong: nothing
      // ever starts playing on its own, so the first song of a session needs an
      // explicit start. Guarded on idle so a mis-click can't cut a live track.
      if (songState.nowPlaying) return;
      advanceSong();
    } else if (message.type === 'song-skip') {
      advanceSong();
    } else if (message.type === 'song-stop') {
      songState.nowPlaying = null;
      broadcast(songStatePayload());
    } else if (message.type === 'song-ended') {
      // Sent by the /music widget when the player reports ENDED. Guarded on the
      // id so a stale widget (one that reconnected after we already moved on)
      // cannot skip the song that is currently playing.
      if (!songState.nowPlaying || songState.nowPlaying.id !== message.id) return;
      advanceSong();
    } else if (message.type === 'song-error') {
      if (!songState.nowPlaying || songState.nowPlaying.id !== message.id) return;
      console.error(`[song] player error on ${songState.nowPlaying.videoId}, skipping`);
      advanceSong();
    } else if (message.type === 'filler-add') {
      addFillerSong(message.link).then((result) => {
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'filler-add-failed', reason: result.reason }));
        }
      });
    } else if (message.type === 'filler-remove') {
      const next = fillerSongs.filter((f) => f.id !== message.id);
      if (next.length === fillerSongs.length) return;
      fillerSongs = next;
      saveFillerSongs();
      broadcast(songStatePayload());
    } else if (message.type === 'set-tts-provider') {
      if (message.provider !== 'local' && message.provider !== 'google') return;
      ttsProvider = message.provider;
      broadcast({ type: 'tts-provider-state', provider: ttsProvider });
    } else if (message.type === 'set-tts-lang') {
      const lang = String(message.lang || '').toLowerCase();
      if (!TTS_LANGS.has(lang)) return;
      ttsLang = lang;
      broadcast({ type: 'tts-lang-state', lang: ttsLang });
    } else if (message.type === 'set-tts-enabled') {
      ttsEnabled = !!message.enabled;
      broadcast({ type: 'tts-enabled-state', enabled: ttsEnabled });
    } else if (message.type === 'set-tts-speed') {
      const speed = Number(message.speed);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 3) return;
      ttsSpeed = speed;
      broadcast({ type: 'tts-speed-state', speed: ttsSpeed });
    } else if (message.type === 'set-tts-read-chance') {
      const chance = Number(message.chance);
      if (!Number.isFinite(chance) || chance < 0 || chance > 1) return;
      ttsReadChance = chance;
      broadcast({ type: 'tts-read-chance-state', chance: ttsReadChance });
    }
  });
});

if (MOCK_MODE) {
  console.log(`MOCK mode: generating fake follows${process.env.MOCK_CHAT === '1' ? ' and chat traffic' : ''} instead of connecting to TikTok.`);

  const mockUsers = [
    'nampeung_99', 'kai_gamer', 'pim.streamfan', 'tanawat_th', 'user_888', 'miko.chan',
    // Emoji nicknames: plain, ZWJ sequence, flag, skin tone, variation selector.
    '🐱miko🐱', '👨‍👩‍👧 family', '🇮🇩 friends', '👍🏽ok', '❤️love',
  ];
  const mockComments = [
    'hi hi, been here since the start',
    'video quality looks great today',
    'what time does the stream end?',
    'you are so good at this',
    'the audio is a bit quiet for me',
    'drop the setup specs please',
    'been watching every day this week',
    'nice nice nice',
    'can you play something chill next?',
    'hello from Indonesia!',
    // Spam/filter fixtures -- kept in their original scripts on purpose so a
    // mock session still exercises Pattern collapse / Blocked word.
    '5555555555',
    '5555 very funny',
    '哈哈哈哈哈哈哈哈哈哈哈哈',
    'good good good good good',
    'very niceeeeeeee',
    'เ ก  เ ก เ ก เ ก เ ก เ ก',
    'ดี ก ก ก   กก ก ก  ก     ก  ปแผ ๔๑+ ๔+๒ ๔๑๒๓๑+๒๑+๒๑+๔ +ูู๑๒ ฿',
    'playing around',
  ];

  const mockAvatar = (nickname) => `https://i.pravatar.cc/150?u=${encodeURIComponent(nickname)}`;

  const mockGifts = [
    { name: 'Rose', image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Ice Cream Cone', image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Glow Stick', image: '' },
  ];

  // Chat-overlay traffic (chat, song requests, stickers, gifts, joins) is
  // opt-in with MOCK_CHAT=1 so plain MOCK=1 only fires follow alerts.
  if (process.env.MOCK_CHAT === '1') {
    setInterval(() => {
      const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
      const message = {
        type: 'chat',
        user: nickname,
        nickname,
        avatarUrl: mockAvatar(nickname),
        comment: mockComments[Math.floor(Math.random() * mockComments.length)],
      };
      console.log(`[MOCK] ${message.nickname}: ${message.comment}`);
      broadcast(message);
      handleSongRequestComment(message.user, message.nickname, message.comment);
    }, 2500);

    // Song requests get their own stream rather than being sprinkled into
    // mockComments, and are cycled instead of randomised, so a short session
    // exercises every refusal path (too long, live stream, missing video,
    // duplicate) instead of depending on luck. All ids are real videos.
    const mockSongs = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // ok -- full link
      'youtu.be/9bZkp7q19f0', // ok -- short link form, no scheme
      'lofi hip hop radio', // ok -- searched by name
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // refused: already requested
      'https://www.youtube.com/watch?v=jfKfPfyJRdk', // refused: 1407-day live archive
      'https://www.youtube.com/watch?v=JGwWNGJdvx8', // ok
      'https://www.youtube.com/watch?v=4xDzrJKXOOY', // refused: in-progress live stream
      'the weeknd blinding lights', // ok -- searched by name
      'https://www.youtube.com/watch?v=zzzzzzzzzzz', // refused: no such video
      'https://www.youtube.com/watch?v=OPf0YbXqDm0', // ok
      'https://www.youtube.com/shorts/60ItHLz5WEA', // ok -- shorts form
      'https://www.youtube.com/watch?v=RgKAFK5djSk', // ok
      'https://www.youtube.com/watch?v=CevxZvSJLk8', // ok
      'https://www.youtube.com/watch?v=hT_nvWreIhg', // ok
    ];

    let mockSongIndex = 0;
    setInterval(() => {
      const nickname = mockUsers[mockSongIndex % mockUsers.length];
      const song = mockSongs[mockSongIndex % mockSongs.length];
      mockSongIndex += 1;
      const message = {
        type: 'chat',
        user: nickname,
        nickname,
        avatarUrl: mockAvatar(nickname),
        comment: `m!p ${song}`,
      };
      console.log(`[MOCK] ${nickname} requested a song: ${song}`);
      broadcast(message);
      handleSongRequestComment(message.user, message.nickname, message.comment);
    }, 9000);

    setInterval(() => {
      const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
      const message = {
        type: 'emote',
        user: nickname,
        nickname,
        avatarUrl: mockAvatar(nickname),
        emoteImages: [mockAvatar('sticker-' + Math.floor(Math.random() * 5))],
      };
      console.log(`[MOCK] ${message.nickname} sent a sticker`);
      broadcast(message);
    }, 11000);

    setInterval(() => {
      const gift = mockGifts[Math.floor(Math.random() * mockGifts.length)];
      const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
      const message = {
        type: 'gift',
        user: nickname,
        nickname,
        avatarUrl: mockAvatar(nickname),
        giftName: gift.name,
        giftImage: gift.image,
        repeatCount: Math.floor(Math.random() * 5) + 1,
      };
      console.log(`[MOCK] ${message.nickname} sent ${message.giftName} x${message.repeatCount}`);
      broadcast(message);
    }, 8000);

    setInterval(() => {
      const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
      const message = {
        type: 'member',
        user: nickname,
        nickname,
        avatarUrl: mockAvatar(nickname),
      };
      console.log(`[MOCK] ${message.nickname} joined`);
      broadcast(message);
    }, 5000);
  }

  setInterval(() => {
    const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
    const message = {
      type: 'follow',
      user: nickname,
      nickname,
      avatarUrl: mockAvatar(nickname),
    };
    console.log(`[MOCK] ${message.nickname} followed`);
    broadcast(message);
  }, 15000);
} else {
  const tiktokConnection = new TikTokLiveConnection(TIKTOK_USERNAME, {});

  function connectToTikTok() {
    tiktokConnection.connect()
      .then((state) => {
        console.log(`Connected to TikTok live room ${state.roomId} (@${TIKTOK_USERNAME})`);
        liveLog('tiktok-state', { event: 'connected', roomId: state.roomId, username: TIKTOK_USERNAME });
        tiktokLiveConnected = true;
        tiktokReconnectAttempt = 0;
        broadcast(tiktokConnectionPayload());
      })
      .catch((err) => {
        console.error('Failed to connect to TikTok live:', err.message);
        liveLog('tiktok-state', { event: 'connect-failed', error: err.message });
        console.error('Retrying in 10s... (make sure the account is live and the username is correct)');
        tiktokLiveConnected = false;
        tiktokReconnectAttempt++;
        broadcast(tiktokConnectionPayload());
        setTimeout(connectToTikTok, 10000);
      });
  }
  connectToTikTok();

  tiktokConnection.on(WebcastEvent.CHAT, (data) => {
    // Wrapped in try/catch so a malformed event (unexpected field shape from
    // TikTok) logs and moves on instead of silently dropping the comment with
    // no trace -- this is the only place a "comment never showed up" report
    // could originate from on our side.
    try {
      const message = {
        type: 'chat',
        user: data.user?.uniqueId,
        nickname: data.user?.nickname,
        comment: data.content,
        avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
      };
      if (isProfaneComment(message.comment)) {
        liveLog('filtered', { reason: 'profanity', user: message.user, content: message.comment });
        console.log(`[filtered] ${message.nickname}: ${message.comment}`);
        return;
      }
      console.log(`${message.nickname}: ${message.comment}`);
      broadcast(message);
      // A Song request is a Comment first and stays one -- it is broadcast and
      // spoken like any other, and only *additionally* considered for the queue.
      handleSongRequestComment(message.user, message.nickname, message.comment);
    } catch (err) {
      liveLog('error', { where: 'chat-handler', user: data?.user?.uniqueId, content: data?.content, error: err.message });
      console.error('[chat] CHAT handler threw for raw event', {
        uniqueId: data?.user?.uniqueId,
        nickname: data?.user?.nickname,
        content: data?.content,
        error: err.stack || err.message,
      });
    }
  });

  tiktokConnection.on(WebcastEvent.GIFT, (data) => {
    // Streakable gifts (gift.type === 1) re-fire on every tap while the
    // sender holds the button, with a rising repeatCount. Only broadcast
    // once the streak actually ends (repeatEnd === 1) so we announce the
    // final combo instead of spamming one line per tap.
    if (data.gift?.type === 1 && data.repeatEnd !== 1) return;

    const message = {
      type: 'gift',
      user: data.user?.uniqueId,
      nickname: data.user?.nickname,
      avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
      giftName: data.gift?.name || 'Gift',
      giftImage: data.gift?.image?.urlList?.[0] || '',
      repeatCount: data.repeatCount || 1,
      diamondCount: (data.gift?.diamondCount || 0) * (data.repeatCount || 1),
    };
    console.log(`${message.nickname} sent ${message.giftName} x${message.repeatCount}`);
    broadcast(message);
  });

  tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
    const message = {
      type: 'member',
      user: data.user?.uniqueId,
      nickname: data.user?.nickname,
      avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
    };
    if (!message.nickname) return;
    console.log(`${message.nickname} joined`);
    broadcast(message);
  });

  tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
    const message = {
      type: 'follow',
      user: data.user?.uniqueId,
      nickname: data.user?.nickname,
      avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
    };
    if (!message.nickname) return;
    console.log(`${message.nickname} followed`);
    broadcast(message);
  });

  // Without an ERROR listener the connector swallows these silently -- and a
  // websocket frame that fails to decode takes every comment in it down with it.
  tiktokConnection.on(ControlEvent.ERROR, ({ info, exception }) => {
    // Connect failures are already logged by connectToTikTok's retry path.
    if (info === 'Error while connecting') return;
    console.error('[tiktok] connector error:', info, exception?.stack || exception);
    liveLog('error', { where: 'connector', info, error: exception?.message || String(exception) });
  });

  // A single message that fails protobuf decoding is skipped by the connector
  // with no event at all, so a viewer whose comments trip it just never shows
  // up. Log those here so a "their chat never appeared" report has a trace.
  // Methods the connector has no proto schema for are dropped the same way
  // (no decodedData, no decodeError). If TikTok moves comments to a new
  // message type, this is the only place it shows up. Logged once per method.
  const unknownMethodsSeen = new Set();
  // High-volume types with nothing a viewer typed; left out of the raw log so
  // the comments aren't buried under thousands of likes and viewer counts.
  const NOISY_RAW_METHODS = new Set(['WebcastLikeMessage', 'WebcastRoomUserSeqMessage', 'WebcastMemberMessage']);
  tiktokConnection.on(ControlEvent.WEBSOCKET_CONNECTED, (wsClient) => {
    wsClient.on('protoMessageFetchResult', (result) => {
      for (const m of result.messages || []) {
        if (m.decodeError) {
          console.error(`[tiktok] failed to decode ${m.method}:`, m.decodeError.message);
          liveLog('tiktok-raw', { method: m.method, decodeError: m.decodeError.message });
        } else if (!m.decodedData) {
          if (!unknownMethodsSeen.has(m.method)) {
            unknownMethodsSeen.add(m.method);
            console.warn(`[tiktok] unknown message type ${m.method} (no schema, dropped by connector)`);
          }
          liveLog('tiktok-raw', { method: m.method, unknown: true });
        } else if (!NOISY_RAW_METHODS.has(m.method)) {
          const d = m.decodedData.data || {};
          liveLog('tiktok-raw', {
            method: m.method,
            msgId: d.common?.msgId,
            user: d.user?.uniqueId,
            nickname: d.user?.nickname,
            content: d.content,
          });
        }
      }
    });
  });

  // Sticker/emote comments (subscriber stickers) arrive as their own event,
  // not CHAT, and carry only images -- no text. Before this handler they never
  // reached the overlay at all.
  tiktokConnection.on(WebcastEvent.EMOTE, (data) => {
    try {
      const message = {
        type: 'emote',
        user: data.user?.uniqueId,
        nickname: data.user?.nickname,
        avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
        emoteImages: (data.emoteList || [])
          .map((emote) => emote?.image?.urlList?.[0])
          .filter(Boolean),
      };
      console.log(`[emote] ${message.nickname}: ${message.emoteImages.length} sticker(s)`);
      if (message.emoteImages.length) broadcast(message);
    } catch (err) {
      liveLog('error', { where: 'emote-handler', user: data?.user?.uniqueId, error: err.message });
      console.error('[emote] EMOTE handler threw', {
        uniqueId: data?.user?.uniqueId,
        error: err.stack || err.message,
      });
    }
  });

  // DISCONNECTED lives on ControlEvent, not WebcastEvent -- WebcastEvent.DISCONNECTED
  // is undefined, so this listener never fired and a dropped connection mid-live
  // was never retried.
  tiktokConnection.on(ControlEvent.DISCONNECTED, () => {
    console.log('Disconnected from TikTok live. Retrying...');
    liveLog('tiktok-state', { event: 'disconnected' });
    tiktokLiveConnected = false;
    broadcast(tiktokConnectionPayload('Disconnected from the live, reconnecting...'));
    setTimeout(connectToTikTok, 5000);
  });
}

// Exposed only so the offline test harness (and quick manual checks) can drive
// a Comment through the song request path without a live TikTok room. Nothing
// in the server itself reads this.
module.exports = { handleSongRequestComment, searchYouTubeSong };
