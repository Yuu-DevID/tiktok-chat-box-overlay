applyTheme(new URLSearchParams(location.search).get("theme")); // e.g. /timer?theme=ocean

const cardEl = document.getElementById("card");
const clockEl = document.getElementById("clock");
const statusEl = document.getElementById("status");

const STATUS_LABELS = {
  idle: "Countdown",
  running: "Countdown",
  paused: "Paused",
  ended: "Time is up!",
};

let tickTimer = null;

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// Only "running" needs a local tick -- idle/paused/ended are all static
// snapshots of server state, nothing to compute against Date.now() for.
function startTick(endsAt) {
  stopTick();
  const render = () => {
    clockEl.textContent = formatMs(endsAt - Date.now());
  };
  render();
  tickTimer = setInterval(render, 250);
}

function render(state) {
  statusEl.textContent = STATUS_LABELS[state.status] || STATUS_LABELS.idle;
  cardEl.classList.toggle("running", state.status === "running");
  cardEl.classList.toggle("ended", state.status === "ended");
  cardEl.classList.toggle("paused", state.status === "paused");

  if (state.status === "running") {
    startTick(state.endsAt);
  } else {
    stopTick();
    if (state.status === "paused") {
      clockEl.textContent = formatMs(state.remainingMs);
    } else if (state.status === "ended") {
      clockEl.textContent = "00:00";
    } else {
      clockEl.textContent = formatMs(state.durationMs);
    }
  }
}

const setWsStatus = attachStatusIndicator();

connectWS((data) => {
  if (data.type !== "timer-state") return;
  render(data);
}, setWsStatus);
