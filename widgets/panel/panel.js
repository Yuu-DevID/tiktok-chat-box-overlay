const MAX_ROWS = 40;
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const emptyTextEl = document.getElementById("empty-text");
const pinnedBar = document.getElementById("pinned-bar");
const pinnedBarNick = document.getElementById("pinned-bar-nick");
const pinnedBarComment = document.getElementById("pinned-bar-comment");
const pinnedBarAuto = document.getElementById("pinned-bar-auto");
const searchInput = document.getElementById("search");
const autoUnpinGroup = document.getElementById("auto-unpin");
let pinnedRow = null;
let autoUnpinTimer = null;
let ws = null;

autoUnpinGroup.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    autoUnpinGroup.dataset.value = btn.dataset.value;
    autoUnpinGroup.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

// Case-insensitive substring match against nickname/comment. Applied both
// on every keystroke and to each newly arriving row so live chat keeps
// respecting whatever's currently typed in the search box.
function matchesSearch(row) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return true;
  return (
    row.dataset.nickname.toLowerCase().includes(q) ||
    row.dataset.comment.toLowerCase().includes(q)
  );
}

function applyFilter() {
  let visibleCount = 0;
  Array.from(listEl.children).forEach((row) => {
    const visible = matchesSearch(row);
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  const hasRows = listEl.children.length > 0;
  if (!hasRows) {
    emptyTextEl.textContent = "Waiting for comments…";
    emptyEl.style.display = "flex";
  } else if (visibleCount === 0) {
    emptyTextEl.textContent = "No comment matches that search";
    emptyEl.style.display = "flex";
  } else {
    emptyEl.style.display = "none";
  }
}

searchInput.addEventListener("input", applyFilter);

function addRow(nickname, comment, avatarUrl) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.nickname = nickname;
  row.dataset.comment = comment;
  row.dataset.avatarUrl = avatarUrl || "";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    avatar.appendChild(img);
  }

  const text = document.createElement("div");
  text.className = "text";
  const nick = document.createElement("div");
  nick.className = "nickname";
  nick.textContent = nickname;
  const body = document.createElement("div");
  body.className = "comment";
  body.textContent = comment;
  text.appendChild(nick);
  text.appendChild(body);

  const flag = document.createElement("span");
  flag.className = "pin-flag";
  flag.textContent = "📌 pinned";
  flag.style.display = "none";

  row.appendChild(avatar);
  row.appendChild(text);
  row.appendChild(flag);

  row.addEventListener("click", () => togglePin(row, flag));

  listEl.prepend(row);
  while (listEl.children.length > MAX_ROWS) {
    const last = listEl.lastChild;
    if (last === pinnedRow) break; // never drop the currently pinned row
    listEl.removeChild(last);
  }
  applyFilter();
}

function togglePin(row, flag) {
  if (row === pinnedRow) {
    unpin();
    return;
  }

  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow.querySelector(".pin-flag").style.display = "none";
  }
  row.classList.add("pinned");
  flag.style.display = "inline";
  pinnedRow = row;
  pinnedBarNick.textContent = row.dataset.nickname;
  pinnedBarComment.textContent = row.dataset.comment;
  pinnedBar.classList.add("show");

  const autoMs = Number(autoUnpinGroup.dataset.value);
  ws.send({
    type: "pin",
    nickname: row.dataset.nickname,
    comment: row.dataset.comment,
    avatarUrl: row.dataset.avatarUrl,
    autoUnpinMs: autoMs,
  });

  clearTimeout(autoUnpinTimer);
  if (autoMs > 0) {
    pinnedBarAuto.textContent = `⏱ auto ${autoMs / 1000}s`;
    pinnedBarAuto.style.display = "inline";
    autoUnpinTimer = setTimeout(unpin, autoMs);
  } else {
    pinnedBarAuto.style.display = "none";
  }
}

function unpin() {
  clearTimeout(autoUnpinTimer);
  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow.querySelector(".pin-flag").style.display = "none";
    pinnedRow = null;
  }
  pinnedBar.classList.remove("show");
  ws.send({ type: "unpin" });
}

pinnedBar.querySelector("#pinned-bar-clear").addEventListener("click", unpin);

document.getElementById("show-summary").addEventListener("click", () => {
  ws.send({ type: "show-summary" });
});

// ---- BRB Timer controls ----
const timerReadout = document.getElementById("timer-readout");
const timerPresets = document.getElementById("timer-presets");
const timerMinInput = document.getElementById("timer-min");
const timerSecInput = document.getElementById("timer-sec");
const timerMessageInput = document.getElementById("timer-message");
let timerTickInterval = null;

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function customDurationMs() {
  const min = Number(timerMinInput.value) || 0;
  const sec = Number(timerSecInput.value) || 0;
  return (min * 60 + sec) * 1000;
}

timerPresets.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const ms = Number(btn.dataset.ms);
    timerMinInput.value = Math.floor(ms / 60000);
    timerSecInput.value = (ms % 60000) / 1000;
    ws.send({ type: "timer-start", durationMs: ms });
  });
});

document.getElementById("timer-start").addEventListener("click", () => {
  ws.send({ type: "timer-start", durationMs: customDurationMs() });
});
document.getElementById("timer-pause").addEventListener("click", () => {
  ws.send({ type: "timer-pause" });
});
document.getElementById("timer-resume").addEventListener("click", () => {
  ws.send({ type: "timer-resume" });
});
document.getElementById("timer-reset").addEventListener("click", () => {
  ws.send({ type: "timer-reset" });
});
timerMessageInput.addEventListener("change", () => {
  ws.send({ type: "timer-set-message", message: timerMessageInput.value });
});

function renderTimerState(state) {
  clearInterval(timerTickInterval);
  timerTickInterval = null;

  if (document.activeElement !== timerMessageInput) {
    timerMessageInput.value = state.message;
  }

  if (state.status === "running") {
    const render = () => (timerReadout.textContent = formatMs(state.endsAt - Date.now()));
    render();
    timerTickInterval = setInterval(render, 250);
  } else if (state.status === "paused") {
    timerReadout.textContent = formatMs(state.remainingMs);
  } else if (state.status === "ended") {
    timerReadout.textContent = "00:00";
  } else {
    timerReadout.textContent = formatMs(state.durationMs);
  }
}

// ---- Song request controls ----
const songEnabledGroup = document.getElementById("song-enabled");
const songAutoGroup = document.getElementById("song-auto");
const songNoticeEl = document.getElementById("song-notice");
const songNoKeyEl = document.getElementById("song-nokey");
const songNowEl = document.getElementById("song-now");
const songIdleEl = document.getElementById("song-idle");
const songNowTitle = document.getElementById("song-now-title");
const songNowBy = document.getElementById("song-now-by");
const songPendingEl = document.getElementById("song-pending");
const songPendingEmpty = document.getElementById("song-pending-empty");
const songPendingCount = document.getElementById("song-pending-count");
const songApprovedEl = document.getElementById("song-approved");
const songApprovedEmpty = document.getElementById("song-approved-empty");
const songApprovedCount = document.getElementById("song-approved-count");
const fillerLinkInput = document.getElementById("filler-link");
const fillerErrorEl = document.getElementById("filler-error");
const fillerListEl = document.getElementById("filler-list");
const fillerEmptyEl = document.getElementById("filler-empty");
const fillerCountEl = document.getElementById("song-filler-count");

songEnabledGroup.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    ws.send({ type: "set-song-enabled", enabled: btn.dataset.value === "on" });
  });
});

songAutoGroup.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    ws.send({ type: "set-song-auto-approve", enabled: btn.dataset.value === "on" });
  });
});

let songNoticeTimer = null;
function renderSongNotice(data) {
  clearTimeout(songNoticeTimer);
  songNoticeEl.textContent = data.ok
    ? `${data.auto ? "Playing" : "Waiting for approval"}: ${data.title} · @${data.nickname}`
    : `Refused @${data.nickname}${data.query ? ` ("${data.query}")` : ""}: ${data.reason}`;
  songNoticeEl.className = `song-notice show ${data.ok ? "ok" : "bad"}`;
  songNoticeTimer = setTimeout(() => {
    songNoticeEl.className = "song-notice";
  }, 12000);
}

document.getElementById("song-start").addEventListener("click", () => ws.send({ type: "song-start" }));
document.getElementById("song-skip").addEventListener("click", () => ws.send({ type: "song-skip" }));
document.getElementById("song-stop").addEventListener("click", () => ws.send({ type: "song-stop" }));

function addFiller() {
  const link = fillerLinkInput.value.trim();
  if (!link) return;
  fillerErrorEl.style.display = "none";
  ws.send({ type: "filler-add", link });
  fillerLinkInput.value = "";
}
document.getElementById("filler-add").addEventListener("click", addFiller);
fillerLinkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addFiller();
});

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// One row shape for all three lists -- they differ only in which buttons hang
// off the end, so the buttons are passed in rather than branched on here.
function songRow(song, subtitle, buttons) {
  const row = document.createElement("div");
  row.className = "song-row";

  const text = document.createElement("div");
  text.className = "song-row-text";
  const title = document.createElement("div");
  title.className = "song-row-title";
  title.textContent = song.title;
  const sub = document.createElement("div");
  sub.className = "song-row-sub";
  sub.textContent = `${subtitle} · ${formatDuration(song.durationSec)}`;
  text.appendChild(title);
  text.appendChild(sub);
  row.appendChild(text);

  buttons.forEach(({ label, className, onClick }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `song-row-btn ${className}`;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    row.appendChild(btn);
  });
  return row;
}

function renderSongState(state) {
  songNoKeyEl.style.display = state.hasApiKey ? "none" : "block";

  const value = state.enabled ? "on" : "off";
  songEnabledGroup.dataset.value = value;
  songEnabledGroup.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === value);
  });

  const autoValue = state.autoApprove ? "on" : "off";
  songAutoGroup.dataset.value = autoValue;
  songAutoGroup.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === autoValue);
  });

  if (state.nowPlaying) {
    songNowEl.classList.add("show");
    songNowTitle.textContent = state.nowPlaying.title;
    songNowBy.textContent = state.nowPlaying.isFiller
      ? "(Filler)"
      : `— requested by ${state.nowPlaying.nickname}`;
  } else {
    songNowEl.classList.remove("show");
  }

  // Nothing plays on its own, so offer an explicit start -- but only when there
  // is actually something for it to play.
  const canStart = !state.nowPlaying && (state.approved.length > 0 || state.fillers.length > 0);
  songIdleEl.classList.toggle("show", canStart);

  songPendingCount.textContent = state.pending.length;
  songPendingEmpty.style.display = state.pending.length === 0 ? "block" : "none";
  songPendingEl.textContent = "";
  state.pending.forEach((song) => {
    songPendingEl.appendChild(
      songRow(song, song.nickname, [
        { label: "✓", className: "ok", onClick: () => ws.send({ type: "song-approve", id: song.id }) },
        { label: "✕", className: "no", onClick: () => ws.send({ type: "song-reject", id: song.id }) },
      ])
    );
  });

  songApprovedCount.textContent = state.approved.length;
  songApprovedEmpty.style.display = state.approved.length === 0 ? "block" : "none";
  songApprovedEl.textContent = "";
  state.approved.forEach((song) => {
    songApprovedEl.appendChild(
      songRow(song, song.nickname, [
        { label: "✕", className: "no", onClick: () => ws.send({ type: "song-reject", id: song.id }) },
      ])
    );
  });

  fillerCountEl.textContent = state.fillers.length;
  fillerEmptyEl.style.display = state.fillers.length === 0 ? "block" : "none";
  fillerListEl.textContent = "";
  state.fillers.forEach((song) => {
    fillerListEl.appendChild(
      songRow(song, song.channel || "Filler", [
        { label: "✕", className: "no", onClick: () => ws.send({ type: "filler-remove", id: song.id }) },
      ])
    );
  });
}

const setWsStatus = attachStatusIndicator();

ws = connectWS((data) => {
  if (data.type === "timer-state") {
    renderTimerState(data);
    return;
  }
  if (data.type === "song-state") {
    renderSongState(data);
    return;
  }
  if (data.type === "filler-add-failed") {
    fillerErrorEl.textContent = data.reason;
    fillerErrorEl.style.display = "block";
    return;
  }
  if (data.type === "song-request-notice") {
    renderSongNotice(data);
    return;
  }
  if (data.type !== "chat") return;
  addRow(data.nickname, data.comment, data.avatarUrl);
}, setWsStatus);

// ---- setup gate ---------------------------------------------------------
(function () {
  const gate = document.getElementById("panel-setup-gate");
  const open = document.getElementById("panel-open-control");
  if (open) {
    open.addEventListener("click", async () => {
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
      if (!state.configured) {
        document.body.dataset.configured = "0";
        if (gate) gate.hidden = false;
        if (open) open.focus();
      }
    })
    .catch(() => {});
})();
