const POLL_MS = 15000; // how often to re-fetch the leaderboard from the API

// Optional overrides via query string, e.g. /top-donate?theme=ocean&seconds=5
const params = new URLSearchParams(location.search);
const CYCLE_MS = Math.max(2, Number(params.get("seconds")) || 3.5) * 1000; // time each rank stays on screen

// gold: crown + laurel + sparkles + pulse ring · silver: star + sparkle · bronze: gem
const MEDALS = {
  1: { rgb: "245, 196, 81", c1: "#FFF1BF", c2: "#F5C451", c3: "#B07A12", r1: "#E5484D", r2: "#B8333A",
       ornD: "M14 4 L12 -5 L17.5 -0.5 L22 -8 L26.5 -0.5 L32 -5 L30 4 Z", laurel: true, spark: true, pulse: true },
  2: { rgb: "213, 217, 226", c1: "#FFFFFF", c2: "#CDD3DE", c3: "#7F889B", r1: "#4C7DFF", r2: "#3157C8",
       ornD: "M22 -7 L23.53 -3.1 L27.7 -2.85 L24.47 -0.2 L25.5 3.85 L22 1.6 L18.5 3.85 L19.53 -0.2 L16.3 -2.85 L20.47 -3.1 Z", laurel: false, spark: true, pulse: false },
  3: { rgb: "227, 163, 116", c1: "#FAD7B5", c2: "#DD9A66", c3: "#95552A", r1: "#2FA37A", r2: "#1F7A5A",
       ornD: "M18.5 -4 L25.5 -4 L28 -0.5 L22 5.5 L16 -0.5 Z", laurel: false, spark: false, pulse: false },
};

applyTheme(params.get("theme")); // themes live in /widgets/shared/themes.js

const cardEl = document.getElementById("card");
const shineEl = document.getElementById("shine");
const emptyEl = document.getElementById("empty");
const slots = [...document.querySelectorAll(".slot")].map((el) => ({
  el,
  badge: el.querySelector(".badge"),
  sub: el.querySelector(".sub"),
  name: el.querySelector(".name"),
  amt: el.querySelector(".amt"),
  amount: el.querySelector(".amount"),
  fx: null, // medal elements animated every frame (pulse, sparkles, shine)
}));

function formatAmount(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- easing helpers (all motion is computed per frame and written as inline
// styles, so it plays identically in a browser and in an OBS browser source)
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function seg(e, delay, dur) { return clamp01((e - delay) / dur); }
function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
function easeIn(p) { return p * p * p; }
function easeInOut(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
function easeBack(p) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
function r2(n) { return Math.round(n * 100) / 100; }
function look(o, y, blur, extra) {
  return `opacity: ${r2(o)}; transform: translateY(${r2(y)}px)${extra || ""}; filter: blur(${r2(blur)}px)`;
}

// enter: badge spins in, then label, name and amount rise in one after another
function enterStyles(e) {
  const b = seg(e, 60, 800), bo = easeOut(b), bb = easeBack(b);
  const t1 = easeOut(seg(e, 160, 600)), t2 = easeOut(seg(e, 230, 650)), a = seg(e, 310, 750);
  return {
    badge: look(clamp01(b * 2.5), 0, 4 * (1 - bo), ` scale(${r2(0.3 + 0.7 * bb)}) rotate(${r2(-160 * (1 - bo))}deg)`),
    sub: look(t1, 20 * (1 - t1), 6 * (1 - t1)),
    name: look(t2, 22 * (1 - t2), 6 * (1 - t2)),
    amt: look(clamp01(a * 2), 20 * (1 - easeOut(a)), 6 * (1 - easeOut(a)), ` scale(${r2(0.8 + 0.2 * easeBack(a))})`),
  };
}

// leave: everything blurs, fades and drifts up, badge spins away
function leaveStyles(e) {
  const b = easeIn(seg(e, 0, 400)), t1 = easeIn(seg(e, 20, 380)), t2 = easeIn(seg(e, 50, 380)), a = easeIn(seg(e, 80, 380));
  return {
    badge: look(1 - b, 0, 4 * b, ` scale(${r2(1 - 0.6 * b)}) rotate(${r2(120 * b)}deg)`),
    sub: look(1 - t1, -20 * t1, 6 * t1),
    name: look(1 - t2, -22 * t2, 6 * t2),
    amt: look(1 - a, -20 * a, 6 * a),
  };
}

// idle shine, sparkles and pulse on the medals, from the clock
function medalFx(now) {
  const sp = (now % 3200) / 3200;
  const sx = sp < 0.45 ? 62 * easeInOut(sp / 0.45) : 62;
  function spark(off) {
    const v = 0.5 - 0.5 * Math.cos(2 * Math.PI * (((now + off) % 1800) / 1800));
    return `transform-box: fill-box; transform-origin: center; opacity: ${r2(0.15 + 0.85 * v)}; transform: scale(${r2(0.4 + 0.6 * v)}) rotate(${r2(45 * v)}deg)`;
  }
  const q = (now % 2000) / 2000;
  return {
    shine: `transform: translateX(${r2(sx)}px)`,
    sparkA: spark(0),
    sparkB: spark(900),
    pulse: `transform-box: fill-box; transform-origin: center; opacity: ${r2(0.8 * (1 - q))}; transform: scale(${r2(0.95 + 0.45 * q)})`,
  };
}

let medalSeq = 0; // keeps SVG gradient/clip ids unique across re-renders

function medalSvg(m) {
  const id = `m${++medalSeq}`;
  return `
<svg width="46" height="50" viewBox="-5 -10 54 58" aria-hidden="true" style="filter: drop-shadow(0 3px 7px rgba(${m.rgb}, 0.45))">
  <defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.c1}"/><stop offset="0.45" stop-color="${m.c2}"/><stop offset="1" stop-color="${m.c3}"/></linearGradient>
    <clipPath id="c${id}"><circle cx="22" cy="20" r="15"/></clipPath>
  </defs>
  ${m.pulse ? `<circle data-fx="pulse" cx="22" cy="20" r="16" fill="none" stroke="${m.c2}" stroke-width="1.5"/>` : ""}
  ${m.laurel ? `<g fill="${m.c2}" stroke="${m.c3}" stroke-width="0.6">
    <ellipse cx="4.5" cy="29" rx="2" ry="4.2" transform="rotate(-40 4.5 29)"/>
    <ellipse cx="1.5" cy="20.5" rx="2" ry="4.2" transform="rotate(-8 1.5 20.5)"/>
    <ellipse cx="3.5" cy="12" rx="2" ry="4.2" transform="rotate(28 3.5 12)"/>
    <ellipse cx="39.5" cy="29" rx="2" ry="4.2" transform="rotate(40 39.5 29)"/>
    <ellipse cx="42.5" cy="20.5" rx="2" ry="4.2" transform="rotate(8 42.5 20.5)"/>
    <ellipse cx="40.5" cy="12" rx="2" ry="4.2" transform="rotate(-28 40.5 12)"/>
  </g>` : ""}
  <polygon points="13,28 9,46 14,42.5 18.5,46 21,32" fill="${m.r1}"/>
  <polygon points="31,28 35,46 30,42.5 25.5,46 23,32" fill="${m.r2}"/>
  <circle cx="22" cy="20" r="15" fill="url(#g${id})" stroke="${m.c3}" stroke-width="1.5"/>
  <g clip-path="url(#c${id})">
    <ellipse cx="22" cy="10.5" rx="11" ry="5" fill="#FFFFFF" opacity="0.35"/>
    <polygon data-fx="shine" points="-14,0 -8,0 -16,40 -22,40" fill="#FFFFFF" opacity="0.55"/>
  </g>
  <circle cx="22" cy="20" r="11.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="1"/>
  <path d="${m.ornD}" fill="${m.c2}" stroke="${m.c3}" stroke-width="1.2" stroke-linejoin="round"/>
  ${m.spark ? `<g fill="#FFFFFF">
    <path data-fx="sparkA" d="M42 -3.5 Q42 0 45.5 0 Q42 0 42 3.5 Q42 0 38.5 0 Q42 0 42 -3.5 Z"/>
    <path data-fx="sparkB" d="M40 33.5 Q40 36 42.5 36 Q40 36 40 38.5 Q40 36 37.5 36 Q40 36 40 33.5 Z"/>
  </g>` : ""}
</svg>`;
}

// Writes one leaderboard entry into a slot (badge, label, name, amount).
function fillSlot(slot, entry, rank) {
  const m = MEDALS[rank];
  if (m) {
    slot.badge.innerHTML = medalSvg(m);
    slot.fx = [...slot.badge.querySelectorAll("[data-fx]")];
  } else {
    slot.badge.innerHTML = "";
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = rank;
    slot.badge.appendChild(chip);
    slot.fx = null;
  }
  slot.sub.textContent = `Rank ${rank}`;
  slot.name.textContent = entry.name;
  slot.amount.textContent = formatAmount(entry.amount);
}

function applyStyles(slot, styles) {
  slot.el.style.opacity = "1";
  slot.badge.style.cssText = styles.badge;
  slot.sub.style.cssText = styles.sub;
  slot.name.style.cssText = styles.name;
  slot.amt.style.cssText = styles.amt;
}

function hideSlot(slot) {
  slot.el.style.opacity = "0";
}

function sameLeaderboard(a, b) {
  return a.length === b.length && a.every((entry, i) => entry.name === b[i].name && entry.amount === b[i].amount);
}

let leaderboard = [];
let currentIndex = 0; // index into `leaderboard` of the entry on screen
let prevIndex = -1; // index of the entry leaving the screen, -1 on first show
let fromAmount = 0; // amount the incoming entry counts up from
let changedAt = 0;
let inSlot = 0; // which of the two slots holds the incoming entry

// Freshly-fetched data waiting to be applied. It only gets swapped in when
// the cycle wraps back to rank #1, so a refresh never cuts an animation short.
let pendingLeaderboard = null;

// Shows the current entry from scratch, with no outgoing slot.
function showFirst(now) {
  currentIndex = 0;
  prevIndex = -1;
  changedAt = now;
  hideSlot(slots[1 - inSlot]);
  if (leaderboard.length === 0) {
    hideSlot(slots[inSlot]);
    emptyEl.style.display = "flex";
    return;
  }
  emptyEl.style.display = "none";
  fromAmount = leaderboard[0].amount;
  fillSlot(slots[inSlot], leaderboard[0], 1);
}

function advance(now) {
  let nextIndex = currentIndex + 1;
  let wrapped = false;
  if (nextIndex >= leaderboard.length) {
    nextIndex = 0;
    wrapped = true;
  }

  if (wrapped && pendingLeaderboard) {
    const next = pendingLeaderboard;
    pendingLeaderboard = null;
    if (next.length === 0 || leaderboard.length === 0) {
      leaderboard = next;
      showFirst(now);
      return;
    }
    fromAmount = leaderboard[currentIndex].amount;
    leaderboard = next;
  } else {
    fromAmount = leaderboard[currentIndex].amount;
  }

  // The outgoing slot keeps showing what it showed; the other slot gets the new entry.
  prevIndex = currentIndex;
  currentIndex = nextIndex;
  inSlot = 1 - inSlot;
  changedAt = now;
  fillSlot(slots[inSlot], leaderboard[currentIndex], currentIndex + 1);
}

function frame() {
  const now = Date.now();
  if (leaderboard.length > 0 && now - changedAt >= CYCLE_MS) advance(now);

  if (leaderboard.length > 0) {
    const e = now - changedAt;
    const first = prevIndex < 0;
    const incoming = slots[inSlot];
    const outgoing = slots[1 - inSlot];
    const to = leaderboard[currentIndex].amount;

    applyStyles(incoming, enterStyles(e));
    if (first) hideSlot(outgoing);
    else applyStyles(outgoing, leaveStyles(e));

    if (!first) {
      incoming.amount.textContent = formatAmount(fromAmount + (to - fromAmount) * easeOut(seg(e, 300, 800)));
    }

    const fx = medalFx(now);
    for (const slot of slots) {
      if (slot.fx) for (const el of slot.fx) el.style.cssText = fx[el.dataset.fx];
    }

    const bump = first ? 0 : Math.sin(Math.PI * seg(e, 0, 600));
    cardEl.style.transform = `scale(${r2(1 + 0.03 * bump)})`;
    shineEl.style.left = `${r2(-60 + 180 * easeInOut(seg(e, 120, 1100)))}%`;

    const medal = MEDALS[currentIndex + 1];
    cardEl.style.boxShadow = medal
      ? `0 14px 30px rgba(24, 18, 48, 0.32), 0 0 28px rgba(${medal.rgb}, 0.18)`
      : "0 14px 30px rgba(24, 18, 48, 0.32)";
  }

  requestAnimationFrame(frame);
}

async function refresh() {
  try {
    const res = await fetch("/api/leaderboard");
    const data = await res.json();
    const next = (data.leaderboard || []).slice(0, 10);
    if (sameLeaderboard(next, pendingLeaderboard || leaderboard)) return;

    if (leaderboard.length === 0) {
      // Nothing on screen yet -- no animation to protect, apply immediately.
      leaderboard = next;
      showFirst(Date.now());
    } else {
      pendingLeaderboard = next;
    }
  } catch (err) {
    console.error("Failed to load leaderboard:", err.message);
  }
}

showFirst(Date.now());
refresh();
setInterval(refresh, POLL_MS);
requestAnimationFrame(frame);
