/* Control room behaviour. Plain globals, no bundler — same convention as the
   overlay widgets. */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const ICONS = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.6 9.6 0 0 1-3-.5L4 21l1.4-4A8.4 8.4 0 1 1 21 11.5Z"/>',
  pin: '<path d="m14 3 7 7-3 1-4 4-1 5-3-3-5 5M9 9l6 6"/>',
  heart: '<path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 22l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  external: '<path d="M14 3h7v7M21 3l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
};

function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.chat}</svg>`;
}

const OVERLAYS = [
  { key: 'chat', path: '/chat', title: 'Chat', desc: 'Live chat, gifts and new viewers.', icon: 'chat', tint: 'rose', wide: true, size: '400 × 720' },
  { key: 'pinned', path: '/pinned', title: 'Pinned', desc: 'Shows the comment you pinned.', icon: 'pin', tint: 'violet', size: '420 × 260' },
  { key: 'follow', path: '/follow', title: 'Follow', desc: 'New follower alert.', icon: 'heart', tint: 'rose', size: '480 × 220' },
  { key: 'top-donate', path: '/top-donate', title: 'Top donate', desc: 'Top 10 donors from EasyDonate.', icon: 'trophy', tint: 'wait', size: '420 × 520' },
];

const CONTROLS = [
  { key: 'timer', path: '/timer', title: 'Timer', desc: 'Break countdown you start from the Panel.', icon: 'clock', tint: 'wait', size: '360 × 220' },
  { key: 'summary', path: '/summary', title: 'Summary', desc: 'Session totals, shown on demand.', icon: 'chart', tint: 'cyan', size: '480 × 300' },
  { key: 'music', path: '/music', title: 'Music', desc: 'Plays m!p requests and your filler songs.', icon: 'music', tint: 'rose', size: '400 × 120' },
];

const TOOLS = [
  { key: 'chatbox', path: '/chatbox', title: 'Chat window', desc: 'Compact chat you can pin on top.', icon: 'monitor', tint: 'rose', window: true },
  { key: 'panel', path: '/panel', title: 'Panel', desc: 'Pin comments, queue songs and run the timer.', icon: 'sliders', tint: 'cyan', window: true },
];

const TINTS = {
  rose: ['rgba(255, 77, 122, 0.16)', '#ff7d9f'],
  cyan: ['rgba(43, 217, 230, 0.14)', '#6fe8f0'],
  violet: ['rgba(122, 92, 255, 0.2)', '#b3a1ff'],
  wait: ['rgba(255, 181, 71, 0.15)', '#ffc978'],
};

const app = {
  configured: false,
  mock: false,
  config: {},
  socket: null,
  activeTimers: {},
};

/* ------------------------------- rendering ------------------------------- */

function cardMarkup(item, variant) {
  const [tile, ink] = TINTS[item.tint] || TINTS.rose;
  const classes = ['card', 'glass'];
  if (variant === 'overlay') {
    classes.push(item.wide ? 'glass--lens' : 'glass--pane');
    if (item.wide) classes.push('card--chat');
  } else if (variant === 'tool') {
    classes.push('glass--frost', 'card--frost');
  } else {
    classes.push('glass--pane');
  }
  const actions = `
    <div class="card-actions">
      <button type="button" class="btn btn--primary" data-copy="${item.path}">
        ${icon('copy', 18)}<span>Copy URL</span>
      </button>
      <button type="button" class="btn btn--ghost" data-preview="${item.path}" data-title="${item.title}">
        ${icon('eye', 18)}<span>Preview</span>
      </button>
    </div>`;
  const toolActions = `
    <div class="card-actions">
      ${item.window ? `<button type="button" class="btn btn--ghost" data-window="${item.path}">${icon('monitor', 18)}<span>Open as window</span></button>` : ''}
      <button type="button" class="btn btn--ghost" data-tab="${item.path}">${icon('external', 18)}<span>Open in tab</span></button>
    </div>`;
  return `
    <article class="${classes.join(' ')}" data-card="${item.key}" style="--tile:${tile};--tile-ink:${ink}">
      <div class="card-head">
        <div class="icon-tile">${icon(item.icon)}</div>
        <div>
          <div class="card-title-row">
            <h3 class="card-title">${item.title}</h3>
            <span class="live-mark" title="Receiving data now"></span>
          </div>
          <div class="card-path">${item.path}</div>
        </div>
      </div>
      <p class="card-desc">${item.desc}</p>
      ${variant === 'tool' ? `<p class="tool-note">A tool for you, not an OBS source.</p>` : ''}
      ${variant === 'tool' ? toolActions : actions}
    </article>`;
}

function renderCards() {
  $('#overlay-grid').innerHTML = OVERLAYS.map((item) => cardMarkup(item, 'overlay')).join('');
  $('#control-grid').innerHTML = CONTROLS.map((item) => cardMarkup(item, 'control')).join('');
  $('#tool-grid').innerHTML = TOOLS.map((item) => cardMarkup(item, 'tool')).join('');
  renderUrlRows();
}

function renderUrlRows() {
  const rows = [...OVERLAYS, ...CONTROLS].map((item) => `
    <div class="url-row">
      <div class="url-meta">
        <div class="url-name">${item.title}</div>
        <div class="url-path">${location.origin}${item.path}</div>
      </div>
      <span class="url-size">${item.size}</span>
      <button type="button" class="btn btn--ghost btn--small" data-copy="${item.path}">Copy</button>
    </div>`);
  $('#url-rows').innerHTML = rows.join('');
}

function stripOrigin(path) {
  return path.replace(/^https?:\/\/[^/]+/, '');
}

/* -------------------------------- clipboard ------------------------------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function markCopied(button) {
  if (!button) return;
  const label = button.querySelector('span');
  const old = label ? label.textContent : button.textContent;
  if (label) {
    label.textContent = 'Copied';
    const svg = button.querySelector('svg');
    if (svg) svg.outerHTML = icon('check', 18);
  } else {
    button.textContent = 'Copied';
  }
  button.dataset.copied = '1';
  window.setTimeout(() => {
    if (label) {
      label.textContent = old;
      const svg = button.querySelector('svg');
      if (svg) svg.outerHTML = icon('copy', 18);
    } else {
      button.textContent = old;
    }
    delete button.dataset.copied;
  }, 1600);
}

/* ------------------------------- live dots -------------------------------- */

function markActive(key) {
  const card = document.querySelector(`[data-card="${key}"]`);
  if (!card) return;
  card.dataset.active = '1';
  clearTimeout(app.activeTimers[key]);
  app.activeTimers[key] = setTimeout(() => {
    card.dataset.active = '0';
  }, 90_000);
}

/* ------------------------------- connection ------------------------------- */

function renderConnection(payload) {
  if (!payload) return;
  const state = payload.state || (payload.connected ? 'live' : 'offline');
  document.body.dataset.conn = state;
  const name = (payload.username || app.config.tiktokUsername || '').replace(/^@/, '');
  let text;
  if (state === 'live') {
    text = name ? `Connected to @${name}. Reading chat.` : 'Connected. Reading chat.';
  } else if (state === 'connecting') {
    text = name ? `Connecting to @${name}${payload.attempts ? `, attempt ${payload.attempts}` : ''}.` : 'Connecting…';
  } else if (state === 'error') {
    text = payload.detail || (name ? `Can't connect to @${name}. Check the spelling, and that the account is live now.` : 'Not connected. Enter your TikTok username in Setup.');
  } else {
    text = name
      ? `Not connected to @${name}. Open Setup to reconnect.`
      : 'Not connected. Enter your TikTok username in Setup.';
  }
  $('#status-text').textContent = text;
  $('#status-pill').title = state === 'live' ? 'Connected. Open setup' : 'Open setup';
}

function applyStats(payload) {
  if (!payload) return;
  $('#stat-comments').textContent = payload.comments ?? 0;
  $('#stat-gifts').textContent = payload.gifts ?? 0;
  $('#stat-diamonds').textContent = payload.giftDiamonds ?? 0;
  $('#stat-viewers').textContent = payload.viewers ?? 0;
}

function applyTts(tts) {
  if (!tts) return;
  setSegmented('provider', tts.provider);
  setSegmented('lang', tts.lang);
  setSegmented('enabled', tts.enabled ? 'on' : 'off');
  setSegmented('speed', String(tts.speed));
  setSegmented('chance', String(tts.readChance));
}

/* -------------------------------- views ---------------------------------- */

function activateView(name) {
  if (name === 'overlays' && !app.configured) name = 'setup';
  $$('.view').forEach((view) => { view.hidden = view.id !== `view-${name}`; });
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  if (name === 'setup') {
    $('#setup-title').textContent = app.configured ? 'Setup' : 'Set up your live';
    $('#setup-lead').textContent = app.configured
      ? 'Change the connection, song requests or voice settings. Saved values apply immediately.'
      : 'Enter the TikTok account whose chat you want to read. The dashboard opens as soon as it is saved.';
  }
  window.scrollTo({ top: 0 });
}

/* ------------------------------- websocket -------------------------------- */

function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws`);
  app.socket = socket;

  socket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message);
  };
  socket.onclose = () => {
    app.socket = null;
    setTimeout(connectSocket, 2000);
  };
}

function handleMessage(message) {
  switch (message.type) {
    case 'tiktok-connection-state':
      renderConnection(message);
      break;
    case 'stats-state':
      applyStats(message);
      break;
    case 'chat':
    case 'gift':
    case 'member':
    case 'emote':
      markActive('chat');
      break;
    case 'follow':
      markActive('follow');
      break;
    case 'pin':
    case 'unpin':
      markActive('pinned');
      break;
    case 'song-state':
      markActive('music');
      break;
    case 'timer-state':
      markActive('timer');
      break;
    case 'summary':
      markActive('summary');
      break;
    case 'tts-provider-state':
      setSegmented('provider', message.provider);
      break;
    case 'tts-lang-state':
      setSegmented('lang', message.lang);
      break;
    case 'tts-enabled-state':
      setSegmented('enabled', message.enabled ? 'on' : 'off');
      break;
    case 'tts-speed-state':
      setSegmented('speed', String(message.speed));
      break;
    case 'tts-read-chance-state':
      setSegmented('chance', String(message.chance));
      break;
    default:
      break;
  }
}

function send(payload) {
  if (app.socket && app.socket.readyState === WebSocket.OPEN) {
    app.socket.send(JSON.stringify(payload));
  }
}

/* -------------------------------- config --------------------------------- */

function fillSetup(config) {
  if (!config) return;
  const map = {
    '#username': config.tiktokUsername,
    '#sign-key': config.signApiKey,
    '#session-id': config.sessionId,
    '#tt-idc': config.ttTargetIdc,
    '#youtube-key': config.youtubeApiKey,
    '#youtube-region': config.youtubeRegion,
    '#easydonate-key': config.easydonateApiKey,
    '#ttl-script': config.tiktokLiveScript,
    '#ttl-cookies': config.tiktokLiveCookies,
    '#ttl-title': config.tiktokLiveTitle,
    '#ttl-topic': config.tiktokLiveTopic,
    '#ttl-region': config.tiktokLiveRegion,
  };
  for (const [selector, value] of Object.entries(map)) {
    const input = $(selector);
    if (input) input.value = value || '';
  }
  const minutes = Math.round((config.songMaxDurationSec || 600) / 60);
  $('#song-max').value = String(minutes);
}

function collectConfig() {
  const base = { ...(app.config || {}) };
  return {
    ...base,
    tiktokUsername: $('#username').value.trim(),
    signApiKey: $('#sign-key').value.trim(),
    sessionId: $('#session-id').value.trim(),
    ttTargetIdc: $('#tt-idc').value.trim(),
    youtubeApiKey: $('#youtube-key').value.trim(),
    youtubeRegion: $('#youtube-region').value.trim() || 'ID',
    songMaxDurationSec: Math.max(1, Number($('#song-max').value) || 10) * 60,
    easydonateApiKey: $('#easydonate-key').value.trim(),
    tiktokLiveScript: $('#ttl-script').value.trim(),
    tiktokLiveCookies: $('#ttl-cookies').value.trim(),
    tiktokLiveTitle: $('#ttl-title').value.trim(),
    tiktokLiveTopic: $('#ttl-topic').value.trim(),
    tiktokLiveRegion: $('#ttl-region').value.trim(),
  };
}

async function saveSetup(event) {
  event.preventDefault();
  const status = $('#form-status');
  const payload = collectConfig();
  if (!payload.tiktokUsername) {
    status.className = 'form-status error';
    status.textContent = 'Enter the TikTok username first.';
    $('#username').focus();
    return;
  }
  $('#save-setup').disabled = true;
  status.className = 'form-status';
  status.textContent = 'Saving…';
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    app.config = result.config || payload;
    app.configured = Boolean(result.configured);
    $('#nav-overlays').disabled = !app.configured;
    status.className = 'form-status ok';
    status.textContent = app.configured ? 'Saved. Connecting…' : 'Saved.';
    if (app.configured) {
      window.setTimeout(() => activateView('overlays'), 500);
    }
  } catch (err) {
    status.className = 'form-status error';
    status.textContent = `Could not save: ${err.message}`;
  } finally {
    $('#save-setup').disabled = false;
  }
}

/* ------------------------------ segmented -------------------------------- */

function setSegmented(group, value) {
  const root = document.querySelector(`[data-tts="${group}"]`);
  if (!root) return;
  root.dataset.value = value;
  $$(`[data-tts="${group}"] button`).forEach((button) => {
    button.classList.toggle('active', button.dataset.value === String(value));
  });
}

function wireSegmented() {
  $$('[data-tts]').forEach((root) => {
    root.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      const group = root.dataset.tts;
      const value = button.dataset.value;
      setSegmented(group, value);
      if (group === 'provider') send({ type: 'set-tts-provider', provider: value });
      if (group === 'lang') send({ type: 'set-tts-lang', lang: value });
      if (group === 'enabled') send({ type: 'set-tts-enabled', enabled: value === 'on' });
      if (group === 'speed') send({ type: 'set-tts-speed', speed: Number(value) });
      if (group === 'chance') send({ type: 'set-tts-read-chance', chance: Number(value) });
    });
  });
}

/* ------------------------------- preview --------------------------------- */

let previewReturnFocus = null;

function openPreview(path, title) {
  previewReturnFocus = document.activeElement;
  $('#preview-title').textContent = title || 'Preview';
  $('#preview-path').textContent = `${location.origin}${path}`;
  $('#preview-frame').src = path;
  $('#preview-layer').hidden = false;
  $('#preview-close').focus();
}

function closePreview() {
  $('#preview-layer').hidden = true;
  $('#preview-frame').src = 'about:blank';
  if (previewReturnFocus && previewReturnFocus.focus) previewReturnFocus.focus();
}

/* ----------------------------- stream key -------------------------------- */

function ttlPayload() {
  return {
    scriptPath: $('#ttl-script').value.trim(),
    cookiesPath: $('#ttl-cookies').value.trim(),
    title: $('#ttl-title').value.trim(),
    topic: $('#ttl-topic').value.trim(),
    region: $('#ttl-region').value.trim(),
  };
}

async function tiktokLive(action) {
  const output = $('#ttl-output');
  const status = $('#ttl-status');
  if (action === 'check') {
    status.textContent = 'Checking…';
    try {
      const params = new URLSearchParams({ script: $('#ttl-script').value.trim() });
      const response = await fetch(`/api/tiktok-live/status?${params}`);
      const result = await response.json();
      status.textContent = result.available
        ? `Found script. Python: ${result.python ? 'yes' : 'missing'}.`
        : 'Script not found at that path.';
    } catch {
      status.textContent = 'Could not check the script.';
    }
    return;
  }
  status.textContent = action === 'create' ? 'Creating room…' : 'Ending room…';
  output.textContent = 'Working…';
  try {
    const response = await fetch(`/api/tiktok-live/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ttlPayload()),
    });
    const result = await response.json().catch(() => ({}));
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    output.textContent = text || result.error || (result.ok ? 'Done.' : `Failed (exit ${result.code}).`);
    status.textContent = result.ok ? 'Done.' : 'Failed — see output.';
  } catch (err) {
    output.textContent = String(err);
    status.textContent = 'Request failed.';
  }
}

/* ------------------------------- windowing -------------------------------- */

async function openWindow(path) {
  const view = path === '/panel' ? 'panel' : path === '/chatbox' ? 'chatbox' : 'control';
  try {
    const response = await fetch('/api/open-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view }),
    });
    if (response.ok) return;
  } catch {
    // fall through to a browser tab
  }
  window.open(path, '_blank');
}

/* --------------------------------- boot ----------------------------------- */

function wireEvents() {
  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      const ok = await copyText(`${location.origin}${copy.dataset.copy}`);
      if (ok) markCopied(copy);
      return;
    }
    const preview = event.target.closest('[data-preview]');
    if (preview) {
      openPreview(preview.dataset.preview, preview.dataset.title);
      return;
    }
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      window.open(tab.dataset.tab, '_blank');
      return;
    }
    const windowButton = event.target.closest('[data-window]');
    if (windowButton) {
      openWindow(windowButton.dataset.window);
      return;
    }
    const nav = event.target.closest('.nav-item');
    if (nav) activateView(nav.dataset.view);
  });

  $('#open-chat-window').addEventListener('click', () => openWindow('/chatbox'));
  $('#status-pill').addEventListener('click', () => activateView('setup'));
  $('#preview-close').addEventListener('click', closePreview);
  $('#preview-layer').addEventListener('click', (event) => {
    if (event.target.id === 'preview-layer') closePreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#preview-layer').hidden) closePreview();
  });

  $('#setup-form').addEventListener('submit', saveSetup);
  $('#reconnect').addEventListener('click', async () => {
    const status = $('#form-status');
    status.className = 'form-status';
    status.textContent = 'Reconnecting…';
    await fetch('/api/reconnect', { method: 'POST' }).catch(() => {});
  });
  $('#show-summary').addEventListener('click', () => send({ type: 'show-summary' }));
  $('#copy-all').addEventListener('click', async () => {
    const lines = [...OVERLAYS, ...CONTROLS].map((item) => `${item.title}: ${location.origin}${item.path}`);
    const ok = await copyText(lines.join('\n'));
    if (ok) markCopied($('#copy-all'));
  });
  $('#ttl-check').addEventListener('click', () => tiktokLive('check'));
  $('#ttl-create').addEventListener('click', () => tiktokLive('create'));
  $('#ttl-end').addEventListener('click', () => tiktokLive('end'));
  wireSegmented();
}

async function boot() {
  renderCards();
  wireEvents();
  activateView('setup');
  connectSocket();

  try {
    const response = await fetch('/api/state');
    const state = await response.json();
    app.configured = Boolean(state.configured);
    app.mock = Boolean(state.mock);
    app.config = state.config || {};
    fillSetup(app.config);
    applyStats({ comments: 0, gifts: 0, giftDiamonds: 0, viewers: 0 });
    applyTts(state.tts);
    renderConnection(state.connection || { state: state.configured ? 'offline' : 'offline' });
    $('#nav-overlays').disabled = !app.configured;
    activateView(app.configured ? 'overlays' : 'setup');
    document.body.dataset.configured = app.configured ? '1' : '0';
    if (!app.configured) {
      const username = $('#username');
      if (username) username.focus();
      window.scrollTo(0, 0);
    }
    if (state.mock && state.connection) renderConnection(state.connection);
  } catch {
    const status = $('#form-status');
    status.className = 'form-status error';
    status.textContent = 'Could not read the app state. Restart the app and try again.';
  }
}

boot();
