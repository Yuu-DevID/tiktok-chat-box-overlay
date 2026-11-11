// Standalone desktop chat window (`/chatbox`). Meant to be opened as its own
// app window by bin/chatbox-window.sh and pinned on top by the desktop
// environment, so it is deliberately compact and control-room-free: read the
// live chat, click a row to pin it to the /pinned overlay, and flip the few
// switches needed during a stream.

const MAX_ROWS = 200;
const DEFAULT_TIMER_MS = 5 * 60000;

const feedWrap = document.getElementById("feed-wrap");
const feed = document.getElementById("feed");
const emptyEl = document.getElementById("empty");
const searchInput = document.getElementById("search");
const jumpBtn = document.getElementById("jump");
const pinBar = document.getElementById("pin-bar");
const pinNick = document.getElementById("pin-nick");
const pinComment = document.getElementById("pin-comment");
const pinAutoSelect = document.getElementById("pin-auto");
const toastEl = document.getElementById("toast");
const connDot = document.getElementById("conn-dot");
const connLabel = document.getElementById("conn-label");

const counterEls = {
  comments: document.getElementById("c-comments"),
  gifts: document.getElementById("c-gifts"),
  viewers: document.getElementById("c-viewers"),
};
const counters = { comments: 0, gifts: 0 };
const seenViewers = new Set();

let pinnedRow = null;
let pinTimer = null;
let following = true;
let toastTimer = null;

const setWsStatus = attachStatusIndicator();
let ws = null;

// ---------------------------------------------------------------------------
// Feed rows
// ---------------------------------------------------------------------------

function currentlyPinned() {
  return pinnedRow;
}

function rowMatchesSearch(row) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return true;
  return (row.dataset.searchText || "").toLowerCase().includes(q);
}

function applyFilter() {
  let visible = 0;
  for (const row of feed.children) {
    const show = rowMatchesSearch(row);
    row.style.display = show ? "" : "none";
    if (show) visible++;
  }
  const emptyText = feed.children.length === 0 ? "Waiting for chat…" : "No comment matches that filter";
  emptyEl.querySelector("span").textContent = visible === 0 ? emptyText : "";
  emptyEl.style.display = visible === 0 ? "flex" : "none";
  if (visible === 0 && feed.children.length > 0) {
    emptyEl.querySelector(".hint").textContent = "Clear the filter to see the chat again";
  }
}

function makeAvatar(avatarUrl) {
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (!avatarUrl) return avatar;
  const img = document.createElement("img");
  img.src = avatarUrl;
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => img.remove();
  avatar.appendChild(img);
  return avatar;
}

// Shared row shell for every event kind; `kind` only drives the colour/label
// treatment in CSS.
function addRow({ kind = "chat", nickname, textContent, avatarUrl, comment, emoteImages }) {
  const row = document.createElement("div");
  row.className = `row ${kind}`;
  const displayNick = nickname || "unknown";
  const bodyText = comment || textContent || "";
  row.dataset.nickname = displayNick;
  row.dataset.comment = bodyText;
  row.dataset.avatarUrl = avatarUrl || "";
  row.dataset.searchText = `${displayNick} ${bodyText}`;

  row.appendChild(makeAvatar(avatarUrl));

  const body = document.createElement("div");
  body.className = "body";
  const nick = document.createElement("div");
  nick.className = "nick";
  nick.textContent = `@${displayNick}`;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = bodyText;
  body.appendChild(nick);
  body.appendChild(text);

  if (emoteImages && emoteImages.length) {
    for (const src of emoteImages) {
      const img = document.createElement("img");
      img.className = "emote";
      img.src = src;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => img.remove();
      body.appendChild(img);
    }
  }

  const flag = document.createElement("div");
  flag.className = "flag";
  flag.textContent = "📌";

  row.appendChild(body);
  row.appendChild(flag);
  row.addEventListener("click", () => togglePin(row));

  feed.appendChild(row);
  while (feed.children.length > MAX_ROWS) {
    const oldest = feed.firstChild;
    if (oldest === currentlyPinned()) break;
    feed.removeChild(oldest);
  }

  applyFilter();
  if (following) feedWrap.scrollTop = feedWrap.scrollHeight;
  return row;
}

function togglePin(row) {
  if (row === pinnedRow) {
    unpin();
    return;
  }
  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow = null;
  }

  row.classList.add("pinned");
  pinnedRow = row;
  pinNick.textContent = row.dataset.nickname;
  pinComment.textContent = row.dataset.comment;
  pinBar.classList.add("show");

  const autoUnpinMs = Number(pinAutoSelect.value) || 0;
  ws.send({
    type: "pin",
    nickname: row.dataset.nickname,
    comment: row.dataset.comment,
    avatarUrl: row.dataset.avatarUrl,
    autoUnpinMs,
  });

  clearTimeout(pinTimer);
  pinTimer = null;
  if (autoUnpinMs > 0) pinTimer = setTimeout(unpin, autoUnpinMs);
}

function unpin() {
  clearTimeout(pinTimer);
  pinTimer = null;
  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow = null;
  }
  pinBar.classList.remove("show");
  ws.send({ type: "unpin" });
}

document.getElementById("pin-clear").addEventListener("click", unpin);

searchInput.addEventListener("input", applyFilter);

// Auto-follow the newest row, but stop the moment the streamer scrolls up to
// read something -- yanking them back down mid-sentence would be worse than
// leaving a "new messages" hint behind.
feedWrap.addEventListener("scroll", () => {
  const distance = feedWrap.scrollHeight - feedWrap.scrollTop - feedWrap.clientHeight;
  following = distance < 40;
});

jumpBtn.addEventListener("click", () => {
  following = true;
  feedWrap.scrollTop = feedWrap.scrollHeight;
});

// ---------------------------------------------------------------------------
// Toast: song request outcomes only. Viewer-facing chat is read-only to us, so
// these notices are for the streamer.
// ---------------------------------------------------------------------------

function showToast(text, kind = "", ms = 7000) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.className = `show ${kind}`.trim();
  toastTimer = setTimeout(() => {
    toastEl.className = "";
  }, ms);
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function renderCounters() {
  counterEls.comments.textContent = counters.comments;
  counterEls.gifts.textContent = counters.gifts;
  counterEls.viewers.textContent = seenViewers.size;
}

function track(data) {
  if (data.type === "chat" || data.type === "emote") {
    counters.comments++;
    if (data.user) seenViewers.add(data.user);
  } else if (data.type === "gift") {
    counters.gifts++;
    if (data.user) seenViewers.add(data.user);
  } else if (data.type === "member" && data.user) {
    seenViewers.add(data.user);
  } else if (data.type === "follow" && data.user) {
    seenViewers.add(data.user);
  } else {
    return;
  }
  renderCounters();
}

// ---------------------------------------------------------------------------
// Connection badge / controls
// ---------------------------------------------------------------------------

function setConnection(kind, label) {
  connDot.className = `conn-dot ${kind}`;
  connLabel.textContent = label;
}

function setToggle(el, on) {
  el.dataset.on = on ? "true" : "false";
}

document.getElementById("tts-toggle").addEventListener("click", (event) => {
  const on = event.currentTarget.dataset.on !== "true";
  setToggle(event.currentTarget, on);
  ws.send({ type: "set-tts-enabled", enabled: on });
});

document.getElementById("tts-lang").addEventListener("change", (event) => {
  ws.send({ type: "set-tts-lang", lang: event.target.value });
});

document.getElementById("req-toggle").addEventListener("click", (event) => {
  const on = event.currentTarget.dataset.on !== "true";
  setToggle(event.currentTarget, on);
  ws.send({ type: "set-song-enabled", enabled: on });
});

document.getElementById("auto-toggle").addEventListener("click", (event) => {
  const on = event.currentTarget.dataset.on !== "true";
  setToggle(event.currentTarget, on);
  ws.send({ type: "set-song-auto-approve", enabled: on });
});

// ---------------------------------------------------------------------------
// Now playing + BRB timer
// ---------------------------------------------------------------------------

const nowRow = document.getElementById("now-row");
const npTitle = document.getElementById("np-title");
const npBy = document.getElementById("np-by");
const npIcon = document.getElementById("np-icon");
const npHint = document.getElementById("np-hint");

function renderSongState(state) {
  setToggle(document.getElementById("req-toggle"), state.enabled);
  setToggle(document.getElementById("auto-toggle"), state.autoApprove);
  npHint.textContent = state.enabled ? "m!p <song or link>" : "requests off";
  npHint.title = state.hasApiKey
    ? "Viewers play songs with m!p <song name> or a YouTube link"
    : "Set YOUTUBE_API_KEY in .env to enable song requests";

  const song = state.nowPlaying;
  nowRow.classList.toggle("playing", Boolean(song));
  if (!song) {
    npIcon.textContent = "▶";
    npTitle.textContent = "Nothing playing";
    npBy.textContent = "";
    return;
  }
  npIcon.textContent = "🎵";
  npTitle.textContent = song.title;
  if (song.isFiller) {
    npBy.textContent = `· filler${song.channel ? ` · ${song.channel}` : ""}`;
  } else {
    npBy.textContent = `· requested by @${song.nickname}`;
  }
}

const timerClock = document.getElementById("timer-clock");
const timerRow = document.getElementById("timer-row");
let timerTick = null;

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderTimerState(state) {
  clearInterval(timerTick);
  timerTick = null;
  timerRow.classList.toggle("running", state.status === "running");

  if (state.status === "running") {
    const tick = () => {
      timerClock.textContent = formatMs(state.endsAt - Date.now());
    };
    tick();
    timerTick = setInterval(tick, 250);
  } else if (state.status === "paused") {
    timerClock.textContent = formatMs(state.remainingMs);
  } else if (state.status === "ended") {
    timerClock.textContent = "00:00";
  } else {
    timerClock.textContent = formatMs(state.durationMs || DEFAULT_TIMER_MS);
  }
}

document.querySelectorAll("[data-timer]").forEach((btn) => {
  btn.addEventListener("click", () => {
    ws.send({ type: "timer-start", durationMs: Number(btn.dataset.timer) });
  });
});
document.getElementById("timer-stop").addEventListener("click", () => {
  ws.send({ type: "timer-reset" });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

ws = connectWS((data) => {
  track(data);

  switch (data.type) {
    case "chat":
      addRow({ kind: "chat", nickname: data.nickname, comment: data.comment, avatarUrl: data.avatarUrl });
      return;
    case "emote":
      addRow({
        kind: "chat",
        nickname: data.nickname,
        comment: data.comment || "",
        avatarUrl: data.avatarUrl,
        emoteImages: data.emoteImages || [],
      });
      return;
    case "gift": {
      const times = data.repeatCount > 1 ? ` ×${data.repeatCount}` : "";
      addRow({
        kind: "gift",
        nickname: data.nickname,
        comment: `sent ${data.giftName}${times}`,
        avatarUrl: data.avatarUrl,
      });
      return;
    }
    case "member":
      addRow({ kind: "member", nickname: data.nickname, comment: "joined", avatarUrl: data.avatarUrl });
      return;
    case "follow":
      addRow({ kind: "follow", nickname: data.nickname, comment: "followed", avatarUrl: data.avatarUrl });
      return;
    case "pin": {
      // A pin from the full /panel should show up here too, so the window
      // always reflects what the overlay is currently showing.
      pinBar.classList.add("show");
      pinNick.textContent = data.nickname;
      pinComment.textContent = data.comment;
      return;
    }
    case "unpin":
      pinBar.classList.remove("show");
      if (pinnedRow) pinnedRow.classList.remove("pinned");
      pinnedRow = null;
      clearTimeout(pinTimer);
      return;
    case "tts-enabled-state":
      setToggle(document.getElementById("tts-toggle"), data.enabled);
      return;
    case "tts-lang-state":
      document.getElementById("tts-lang").value = data.lang;
      return;
    case "song-state":
      renderSongState(data);
      return;
    case "song-request-notice":
      if (data.ok) {
        showToast(`✅ ${data.auto ? "Playing" : "Queued"}: ${data.title} · @${data.nickname}`, "ok");
      } else {
        showToast(`⛔ @${data.nickname}: ${data.reason}`, "bad");
      }
      return;
    case "timer-state":
      renderTimerState(data);
      return;
    case "tiktok-connection-state": {
      if (data.connected) {
        setConnection("live", "LIVE");
      } else {
        setConnection("offline", "TikTok offline");
      }
      connLabel.title = data.detail || "";
      return;
    }
    default:
      return;
  }
}, (connected) => {
  setWsStatus(connected);
  if (connected) {
    setConnection("offline", "Server online");
  } else {
    setConnection("noserver", "Server offline");
  }
});

renderCounters();
applyFilter();

// ---- demo mode: /chatbox?demo=1 -----------------------------------------
// Fills the window with sample rows so its layout can be checked (and the
// window positioned) without a live room. Purely client-side.
if (new URLSearchParams(location.search).get("demo") === "1") {
  setConnection("live", "LIVE (demo)");
  const samples = [
    { kind: "member", nickname: "miko.chan", comment: "joined" },
    { kind: "chat", nickname: "kai_gamer", comment: "hi hi, been here since the start" },
    { kind: "gift", nickname: "pim.streamfan", comment: "sent Rose ×5" },
    { kind: "chat", nickname: "nampeung_99", comment: "the new overlay looks clean, love the mint bubbles" },
    { kind: "follow", nickname: "sky.blue", comment: "followed" },
    { kind: "chat", nickname: "tanawat_th", comment: "can you play some lofi next? m!p lofi hip hop radio" },
  ];
  for (const s of samples) {
    counters.comments += s.kind === "chat" ? 1 : 0;
    counters.gifts += s.kind === "gift" ? 1 : 0;
    seenViewers.add(s.nickname);
    addRow(s);
  }
  renderCounters();
  renderSongState({
    enabled: true,
    autoApprove: true,
    hasApiKey: true,
    nowPlaying: { id: "demo", title: "Midnight City", nickname: "kai_gamer", isFiller: false },
  });
  renderTimerState({ status: "running", endsAt: Date.now() + 4 * 60000 });
  if (feed.firstChild) togglePin(feed.firstChild);
}

// ---- setup gate / window hint -------------------------------------------
// The chat window must never open as a blank panel: if the account has not
// been configured yet, it says so and offers the control room. The window
// launcher appends ?window=1 so the KDE pin hint only appears there.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get("window") === "1") {
    const hint = document.getElementById("window-hint");
    if (hint) hint.hidden = false;
  }
  if (params.get("demo") === "1") return;

  const gate = document.getElementById("setup-gate");
  const openControl = document.getElementById("open-control");
  if (openControl) {
    openControl.addEventListener("click", async () => {
      try {
        const response = await fetch("/api/open-window", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ view: "control" }),
        });
        if (!response.ok) throw new Error();
      } catch {
        window.open("/", "_blank");
      }
    });
  }

  fetch("/api/state")
    .then((response) => response.json())
    .then((state) => {
      if (!state.configured && gate) {
        gate.hidden = false;
        const empty = document.getElementById("empty");
        if (empty) empty.style.display = "none";
        if (openControl) openControl.focus();
      }
    })
    .catch(() => {});
})();
