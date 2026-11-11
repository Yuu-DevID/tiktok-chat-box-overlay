// Shared helpers reused across the split overlay widgets (chat, pinned,
// panel, top-donate). Plain globals on purpose -- no bundler/ES modules in
// this project, and each widget is a separate OBS/Streamlabs browser source with
// its own JS context anyway, so there's nothing to share at runtime besides code.

// Same origin as the page: the Rust server serves HTTP and WebSocket on one port.
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

// Returns a stable { send } wrapper rather than the raw WebSocket, since the
// underlying socket is replaced on every auto-reconnect -- callers that hold
// on to the return value (panel.html, to send pin/unpin) would otherwise end
// up sending on a stale, closed socket after the first disconnect.
// onStatus(connected: boolean), if given, fires on open and on close/error.
function connectWS(onMessage, onStatus) {
  let socket;

  function open() {
    socket = new WebSocket(WS_URL);
    socket.onopen = () => onStatus && onStatus(true);
    socket.onmessage = (event) => onMessage(JSON.parse(event.data));
    socket.onclose = () => {
      onStatus && onStatus(false);
      setTimeout(open, 3000);
    };
  }
  open();

  return {
    send: (payload) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    },
  };
}

// Small fixed-corner dot, hidden while connected and only surfacing when the
// WS drops/reconnects -- so it stays out of the way on stream but still
// flags a real problem. Returns setStatus(connected) to pass as connectWS's
// onStatus callback.
function attachStatusIndicator() {
  const el = document.createElement("div");
  el.id = "ws-status";
  el.innerHTML = '<span class="ws-status-dot"></span><span class="ws-status-text">reconnecting…</span>';
  const style = document.createElement("style");
  style.textContent = `
    #ws-status {
      position: fixed;
      top: 10px;
      left: 10px;
      display: none;
      align-items: center;
      gap: 6px;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      font-family: "Kanit", "Segoe UI", "Sarabun", sans-serif;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 999px;
      z-index: 9999;
    }
    #ws-status.show { display: flex; }
    .ws-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ff5b5b;
      box-shadow: 0 0 8px 1px rgba(255, 91, 91, 0.8);
      animation: ws-status-pulse 1s ease-in-out infinite;
    }
    @keyframes ws-status-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(el);

  return function setStatus(connected) {
    el.classList.toggle("show", !connected);
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Real TikTok profile picture only -- no letter-avatar fallback. Returns null
// when there's no avatarUrl, or removes itself from the DOM if the CDN image
// fails to load.
function createAvatar(avatarUrl) {
  if (!avatarUrl) return null;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const img = document.createElement("img");
  img.src = avatarUrl;
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => avatar.remove();
  avatar.appendChild(img);
  return avatar;
}

// Small role badge shown next to the avatar (gift/member lines only).
function createBadge(badgeClass, fallbackEmoji) {
  const badge = document.createElement("div");
  badge.className = `badge ${badgeClass}`;
  badge.textContent = fallbackEmoji;
  return badge;
}

function buildLine(extraClass, nickname, avatarUrl, badge) {
  const line = document.createElement("div");
  line.className = extraClass ? `chat-line ${extraClass}` : "chat-line";

  const header = document.createElement("div");
  header.className = "line-header";
  const avatar = createAvatar(avatarUrl);
  if (avatar) header.appendChild(avatar);
  if (badge) header.appendChild(badge);
  const nick = document.createElement("span");
  nick.className = "nickname";
  nick.textContent = nickname;
  header.appendChild(nick);

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  line.appendChild(header);
  line.appendChild(bubble);
  return { line, bubble };
}

// container/maxLines passed in (instead of a shared global) so chat.html and
// events.html can each keep their own #chat-box and cap independently.
function pushLine(container, line, maxLines) {
  container.prepend(line);
  while (container.children.length > maxLines) {
    container.removeChild(container.lastChild);
  }
  // Only fade the top edge once messages actually overflow the box -- otherwise
  // a single early comment gets faded for no reason.
  container.classList.toggle("overflowing", container.scrollHeight > container.clientHeight);
}
