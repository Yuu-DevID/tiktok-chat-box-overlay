// Reads a live log written by server.js (logs/live-YYYY-MM-DD.jsonl) and
// shows, for every comment, how far it got: received from TikTok ->
// broadcast to overlays -> rendered by an overlay.
//
//   node trace-live-log.js                 today's log
//   node trace-live-log.js 2026-09-25      a given day
//   node trace-live-log.js 2026-09-25 bob  only comments from users/nicknames containing "bob"
const fs = require('fs');
const path = require('path');

const today = new Date();
const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const date = process.argv[2] || defaultDate;
const filter = (process.argv[3] || '').toLowerCase();
const file = path.join(__dirname, 'logs', `live-${date}.jsonl`);

if (!fs.existsSync(file)) {
  console.error(`No log at ${file}`);
  process.exit(1);
}

const entries = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const renderedIds = new Set(entries.filter((e) => e.stage === 'overlay' && e.event === 'rendered').map((e) => e.logId));
const broadcasts = entries.filter((e) => e.stage === 'broadcast');
const time = (t) => new Date(t).toLocaleTimeString('th-TH', { hour12: false });
const matches = (e) => !filter || `${e.user} ${e.nickname}`.toLowerCase().includes(filter);

// Pass 1: pair each raw TikTok comment with the broadcast it became, by user +
// text in order -- the connector doesn't pass TikTok's msgId through.
for (const e of entries) {
  if (e.stage !== 'tiktok-raw') continue;
  if (e.method !== 'WebcastChatMessage' && e.method !== 'WebcastEmoteChatMessage') continue;
  const type = e.method === 'WebcastChatMessage' ? 'chat' : 'emote';
  const b = broadcasts.find(
    (b) => !b.raw && b.type === type && b.user === e.user && (type === 'emote' || b.comment === e.content),
  );
  if (b) b.raw = e;
  e.broadcast = b || null;
}

function renderStatus(b) {
  if (!b) return 'NOT BROADCAST (dropped on the server)';
  if (renderedIds.has(b.logId)) return 'ok';
  return b.clients === 0 ? 'NOT RENDERED (no overlay connected)' : 'NOT RENDERED (overlay got it but did not report rendering)';
}

function printComment(e, user, nickname, text, b) {
  const status = renderStatus(b);
  if (status === 'NOT BROADCAST (dropped on the server)') counts.notBroadcast++;
  else if (status !== 'ok') counts.notRendered++;
  console.log(`${time(e.t)}  ${status === 'ok' ? '  ' : '!!'} @${user} (${nickname}): ${text}${status === 'ok' ? '' : '   <-- ' + status}`);
}

// Pass 2: everything in time order. Broadcasts with no raw entry (mock mode)
// are shown on their own so the render check still works there.
const counts = { comments: 0, notBroadcast: 0, notRendered: 0 };
console.log(`Log: ${file}\n`);
for (const e of entries) {
  if (e.stage === 'tiktok-state' || e.stage === 'error' || (e.stage === 'ws-client' && !filter)) {
    const { t, stage, ...rest } = e;
    console.log(`${time(t)}  -- ${stage}: ${JSON.stringify(rest)}`);
  } else if (e.stage === 'overlay' && e.event === 'hello' && !filter) {
    console.log(`${time(e.t)}  -- overlay opened: ${e.page} (${e.size})`);
  } else if (e.stage === 'overlay' && e.event === 'handler-error') {
    console.log(`${time(e.t)}  !! overlay ${e.page} threw on logId ${e.logId}: ${e.error}`);
  } else if (e.stage === 'tiktok-raw' && (e.decodeError || e.unknown)) {
    console.log(`${time(e.t)}  !! ${e.method} ${e.decodeError ? 'failed to decode: ' + e.decodeError : 'unknown type, dropped by connector'}`);
  } else if (e.stage === 'tiktok-raw' && 'broadcast' in e && matches(e)) {
    counts.comments++;
    printComment(e, e.user, e.nickname, e.method === 'WebcastChatMessage' ? e.content : '[sticker]', e.broadcast);
  } else if (e.stage === 'broadcast' && e.type !== 'gift' && !e.raw && matches(e)) {
    counts.comments++;
    printComment(e, e.user, e.nickname, e.type === 'chat' ? e.comment : '[sticker]', e);
  }
}

console.log(`\n${counts.comments} comments, ${counts.notBroadcast} not broadcast, ${counts.notRendered} broadcast but not rendered.`);
