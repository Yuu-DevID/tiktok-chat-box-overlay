// Throwaway end-to-end check for the song request flow. Stubs YouTube at the
// https layer so no key or real network is needed: the search results page for
// name-based requests, and the Data API's videos.list for validation.
const https = require('https');
const { EventEmitter } = require('events');
const { URL } = require('url');

const VIDEOS = {
  aaaaaaaaaaa: { dur: 'PT3M30S', embeddable: true, title: 'Good Song' },
  bbbbbbbbbbb: { dur: 'PT3M10S', embeddable: true, title: 'Second Song' },
  ccccccccccc: { dur: 'PT4M00S', embeddable: false, title: 'Blocked Embed' },
  ddddddddddd: { dur: 'PT45M00S', embeddable: true, title: 'Way Too Long' },
  eeeeeeeeeee: { dur: 'PT2M00S', embeddable: true, title: 'Filler Track' },
  fffffffffff: { dur: 'P0D', embeddable: true, title: 'Live Radio' },
  ggggggggggg: { dur: 'P1407DT10H11M52S', embeddable: true, title: 'Lofi Archive' },
  hhhhhhhhhhh: { dur: 'PT3M00S', embeddable: true, title: 'Searched Song' },
  iiiiiiiiiii: { dur: 'PT2M40S', embeddable: true, title: 'Playable Second' },
};

// Queries the fake results page answers, so `m!p <name>` resolves offline.
// Values are candidate lists in result order, like the real page.
const SEARCH_RESULTS = {
  'searched song': ['hhhhhhhhhhh'],
  'filler song': ['eeeeeeeeeee'],
  'mixed results': ['ccccccccccc', 'iiiiiiiiiii'],
};

function fakeResponse(callback, body) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  setImmediate(() => {
    callback(res);
    res.emit('data', body);
    res.emit('end');
  });
  // The request handle needs a no-op timeout hook; the real client calls
  // req.setTimeout to protect against stalled upstreams.
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  return req;
}

const realGet = https.get;
https.get = (url, opts, cb) => {
  if (typeof url !== 'string') return realGet(url, opts, cb);
  const callback = typeof opts === 'function' ? opts : cb;

  if (url.includes('www.youtube.com/results')) {
    const query = new URL(url).searchParams.get('search_query');
    const videoIds = SEARCH_RESULTS[(query || '').toLowerCase()] || [];
    const data = {
      contents: videoIds.map((videoId) => ({ videoRenderer: { videoId } })),
    };
    const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
    return fakeResponse(callback, html);
  }

  if (!url.includes('googleapis.com/youtube')) return realGet(url, opts, cb);

  const id = /[?&]id=([^&]+)/.exec(url)[1];
  const v = VIDEOS[id];
  const body = JSON.stringify({
    items: v
      ? [{
          snippet: { title: v.title, channelTitle: 'Test Channel' },
          contentDetails: { duration: v.dur },
          status: { embeddable: v.embeddable },
        }]
      : [],
  });
  return fakeResponse(callback, body);
};

const os = require('os');
const fsNode = require('fs');
// Never the real filler-songs.json -- a test run must not touch curated data.
const TEST_FILLER_FILE = require('path').join(os.tmpdir(), `filler-test-${process.pid}.json`);
process.env.FILLER_SONGS_FILE = TEST_FILLER_FILE;
const cleanup = () => { try { fsNode.unlinkSync(TEST_FILLER_FILE); } catch {} };
process.on('exit', cleanup);

process.env.YOUTUBE_API_KEY = 'test-key';
process.env.HTTP_PORT = '8090';
process.env.WS_PORT = '8091';
process.env.MOCK = '0';
process.env.TIKTOK_USERNAME = '___offline_test___';

const server = require('./server.js');

const WebSocket = require('ws');
const link = (id) => `https://www.youtube.com/watch?v=${id}`;

setTimeout(() => {
  const ws = new WebSocket('ws://localhost:8091');
  let state = null;
  let lastNotice = null;
  const failures = [];
  ws.on('message', (raw) => {
    const d = JSON.parse(raw);
    if (d.type === 'song-state') state = d;
    if (d.type === 'song-request-notice') lastNotice = d;
  });

  const send = (m) => ws.send(JSON.stringify(m));
  const ask = (user, text) => server.handleSongRequestComment(user, user, text);
  const linkReq = (user, id) => ask(user, `m!p ${link(id)}`);
  const legacyReq = (user, id) => ask(user, `/music ${link(id)}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (label, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures.push(label);
  };

  ws.on('open', async () => {
    await wait(200);
    check('starts enabled when a key is set', state.enabled === true);
    check('has api key', state.hasApiKey === true);
    check('auto-approve defaults on', state.autoApprove === true);

    // Requests while switched off are ignored entirely.
    send({ type: 'set-song-enabled', enabled: false });
    await wait(100);
    await linkReq('u1', 'aaaaaaaaaaa');
    await wait(100);
    check('ignores requests while disabled', state.pending.length === 0 && state.nowPlaying === null);

    send({ type: 'set-song-enabled', enabled: true });
    await wait(100);

    await ask('u1', `play this ${link('aaaaaaaaaaa')}`);
    await wait(150);
    check('ignores a link without the m!p command', state.pending.length === 0 && state.nowPlaying === null);

    // Name-based request: the search page resolves it, then the same
    // validation path runs and Auto approval starts it immediately.
    await ask('u2', 'm!p searched song');
    await wait(250);
    check('searches a song name and plays it', state.nowPlaying && state.nowPlaying.title === 'Searched Song');
    check('auto-approval bypasses the pending list', state.pending.length === 0 && state.approved.length === 0);
    check('notice reports the accepted request', lastNotice && lastNotice.ok === true && lastNotice.title === 'Searched Song');

    await linkReq('u3', 'hhhhhhhhhhh');
    await wait(150);
    check('refuses a video that is already taken', state.approved.length === 0 && state.pending.length === 0);

    for (const [id, label] of [
      ['ccccccccccc', 'refuses un-embeddable'],
      ['ddddddddddd', 'refuses over-length'],
      ['fffffffffff', 'refuses in-progress live stream (P0D)'],
      ['ggggggggggg', 'refuses day-length duration'],
      ['zzzzzzzzzzz', 'refuses unknown video'],
    ]) {
      await linkReq('u3', id);
      await wait(150);
      check(label, state.approved.length === 0 && state.pending.length === 0);
    }

    // Auto-approved requests still queue behind whatever is playing.
    await linkReq('u1', 'bbbbbbbbbbb');
    await wait(150);
    check('auto-approved request queues behind current song', state.approved.length === 1);
    check('current song keeps playing', state.nowPlaying.title === 'Searched Song');

    await legacyReq('u1', 'aaaaaaaaaaa');
    await wait(150);
    check('one waiting request per viewer', state.approved.length === 1);

    send({ type: 'song-ended', id: state.nowPlaying.id });
    await wait(150);
    check('ended song advances to the queued request', state.nowPlaying.title === 'Second Song');
    check('queue drained', state.approved.length === 0);

    // Manual mode: requests wait for an explicit approval instead of playing.
    send({ type: 'set-song-auto-approve', enabled: false });
    await wait(100);
    check('auto-approve can be switched off', state.autoApprove === false);

    send({ type: 'song-stop' });
    await wait(100);
    await ask('u2', 'm!p good song'); // fake search has no "good song" -> Data API? no key path
    await wait(200);
    check('manual mode keeps the player idle', state.nowPlaying === null);

    await linkReq('u2', 'aaaaaaaaaaa');
    await wait(150);
    check('manual mode queues for approval', state.pending.length === 1);
    check('nothing plays before approval', state.nowPlaying === null);

    send({ type: 'song-approve', id: state.pending[0].id });
    await wait(150);
    check('approval starts playback', state.nowPlaying && state.nowPlaying.title === 'Good Song');
    check('pending drained', state.pending.length === 0);

    // Filler songs accept a name too.
    send({ type: 'filler-add', link: 'filler song' });
    await wait(250);
    check('filler added by song name', state.fillers.length === 1 && state.fillers[0].title === 'Filler Track');

    // Nothing plays on its own: a filler sitting in an idle session stays
    // silent until the streamer explicitly starts it.
    send({ type: 'song-start' });
    await wait(150);
    check('song-start is a no-op while a song plays', state.nowPlaying.title === 'Good Song');

    // Queue is empty now, so the filler takes over and is NOT consumed.
    send({ type: 'song-ended', id: state.nowPlaying.id });
    await wait(150);
    check('falls back to filler', state.nowPlaying.title === 'Filler Track');
    check('filler marked as such', state.nowPlaying.isFiller === true);
    check('filler not consumed', state.fillers.length === 1);

    send({ type: 'song-ended', id: state.nowPlaying.id });
    await wait(150);
    check('filler repeats when still empty', state.nowPlaying.title === 'Filler Track');

    // A stale widget must not be able to skip the live song.
    const liveId = state.nowPlaying.id;
    send({ type: 'song-ended', id: 'stale-id' });
    await wait(150);
    check('ignores stale song-ended', state.nowPlaying.id === liveId);

    // Re-enabling Auto drains anything already waiting for approval.
    await linkReq('u3', 'aaaaaaaaaaa');
    await wait(150);
    check('recently played video stays un-requestable', state.pending.length === 0 && state.approved.length === 0);

    send({ type: 'set-song-enabled', enabled: false });
    await wait(150);
    check('disabling clears queues', state.pending.length === 0 && state.approved.length === 0);
    check('disabling leaves current song alone', state.nowPlaying !== null);

    send({ type: 'song-stop' });
    await wait(150);
    check('stop returns to idle', state.nowPlaying === null);

    // A search whose first hit is unplayable falls through to the next one.
    send({ type: 'set-song-enabled', enabled: true });
    send({ type: 'set-song-auto-approve', enabled: true });
    await wait(100);
    await ask('u4', 'm!p mixed results');
    await wait(400);
    check('skips unplayable search hit and plays the next', state.nowPlaying && state.nowPlaying.title === 'Playable Second');
    send({ type: 'song-stop' });
    await wait(100);

    send({ type: 'song-start' });
    await wait(150);
    check('song-start plays a filler from idle', state.nowPlaying && state.nowPlaying.isFiller === true);

    console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
    ws.close();
    process.exit(failures.length === 0 ? 0 : 1);
  });
}, 500);
