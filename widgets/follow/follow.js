// Follow alert: pops a card for each new follower, one at a time.
// ?theme=midnight|ocean|berry|emerald|sunset|frost  (default midnight)
// ?seconds=5   how long each alert stays up (3-10)
// ?demo=1      loop sample names without a live connection (for positioning in OBS)
//
// Every motion is computed per frame in JS and written as inline styles
// (ported from the StreamLab "Follow Alert" design), so it plays identically
// in a normal browser and in an OBS/Streamlabs browser source.

const params = new URLSearchParams(location.search);

// Own palette rather than shared/themes.js -- this design needs extra tones
// (solid, light, label, rgb) the other cards don't use.
const FOLLOW_THEMES = {
  midnight: { bg: "rgba(26, 19, 48, 0.82)", solid: "#1A1330", text: "#F6F3FF", sub: "rgba(246, 243, 255, 0.68)", label: "#2BD9E6", ts: "0 1px 2px rgba(0, 0, 0, 0.45)", light: "#FF4D7A", accent: "#2BD9E6", rgb: "255, 77, 122", chipFg: "#F6F3FF" },
  ocean:    { bg: "rgba(14, 30, 56, 0.82)", solid: "#0E1E38", text: "#FFFFFF", sub: "#CADCF0", label: "#93DCFD", ts: "0 1px 2px rgba(0, 0, 0, 0.45)", light: "#7DD3FC", accent: "#38BDF8", rgb: "56, 189, 248", chipFg: "#E0F2FE" },
  berry:    { bg: "rgba(58, 20, 44, 0.82)", solid: "#3A142C", text: "#FFFFFF", sub: "#F0CFDF", label: "#FDB6D3", ts: "0 1px 2px rgba(0, 0, 0, 0.45)", light: "#FDA4C8", accent: "#F472B6", rgb: "244, 114, 182", chipFg: "#FCE7F3" },
  emerald:  { bg: "rgba(10, 44, 38, 0.82)", solid: "#0A2C26", text: "#FFFFFF", sub: "#C6E8DC", label: "#86EFC4", ts: "0 1px 2px rgba(0, 0, 0, 0.45)", light: "#6EE7B7", accent: "#34D399", rgb: "52, 211, 153", chipFg: "#D1FAE5" },
  sunset:   { bg: "rgba(50, 30, 18, 0.82)", solid: "#321E12", text: "#FFFFFF", sub: "#F0DCC6", label: "#FDDB6E", ts: "0 1px 2px rgba(0, 0, 0, 0.45)", light: "#FCD34D", accent: "#F59E0B", rgb: "245, 158, 11", chipFg: "#FEF3C7" },
  frost:    { bg: "rgba(255, 255, 255, 0.9)", solid: "#FFFFFF", text: "#141022", sub: "#3F3A52", label: "#5B39D6", ts: "0 1px 0 rgba(255, 255, 255, 0.6)", light: "#A78BFA", accent: "#6D4AE8", rgb: "109, 74, 232", chipFg: "#1F1B2E" },
};

const th = FOLLOW_THEMES[params.get("theme")] || FOLLOW_THEMES.midnight;
const rootStyle = document.documentElement.style;
rootStyle.setProperty("--bg", th.bg);
rootStyle.setProperty("--solid", th.solid);
rootStyle.setProperty("--text", th.text);
rootStyle.setProperty("--sub", th.sub);
rootStyle.setProperty("--label", th.label);
rootStyle.setProperty("--ts", th.ts);
rootStyle.setProperty("--light", th.light);
rootStyle.setProperty("--accent", th.accent);
rootStyle.setProperty("--rgb", th.rgb);
rootStyle.setProperty("--chip-fg", th.chipFg);

const SHOW_MS = Math.min(10, Math.max(3, Number(params.get("seconds")) || 5)) * 1000;
const GAP_MS = 800; // empty time between two alerts
const MAX_QUEUE = 30; // a follow raid shouldn't keep alerts running for an hour

const $ = (id) => document.getElementById(id);
const el = {
  card: $("card"), halo: $("halo"), shine: $("shine"), bar: $("bar"),
  wave1: $("wave1"), wave2: $("wave2"), avatar: $("avatar"), ring: $("ring"),
  plus: $("plus"), initial: $("initial"), img: $("avatar-img"),
  sub: $("sub"), spark: $("spark"), name: $("name"), thanks: $("thanks"),
  chip: $("chip"), beat: $("beat"),
};

// ---- easing helpers (same curves as the design) ----
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function seg(e, delay, dur) { return clamp01((e - delay) / dur); }
function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
function easeIn(p) { return p * p * p; }
function easeInOut(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
function easeBack(p) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
function r2(n) { return Math.round(n * 100) / 100; }
function look(node, o, y, blur, extra) {
  node.style.opacity = r2(o);
  node.style.transform = "translateY(" + r2(y) + "px)" + (extra || "");
  node.style.filter = "blur(" + r2(blur) + "px)";
}

// ---- confetti burst from the avatar: fixed angles, sizes and colors ----
const CONFETTI_COLORS = [th.light, th.accent, "#FFFFFF"];
const pieces = [];
for (let i = 0; i < 14; i++) {
  const pc = {
    a: (i / 14) * Math.PI * 2 + (i % 2 ? 0.18 : -0.1),
    d: 46 + (i * 37 % 5) * 7,
    w: i % 3 === 0 ? 6 : 3.5,
    h: i % 3 === 0 ? 6 : 9,
    round: i % 3 === 0,
    spin: (i % 2 ? 1 : -1) * (180 + i * 25),
    node: document.createElement("span"),
  };
  const s = pc.node.style;
  s.width = pc.w + "px";
  s.height = pc.h + "px";
  s.margin = (-pc.h / 2) + "px 0 0 " + (-pc.w / 2) + "px";
  s.borderRadius = pc.round ? "50%" : "2px";
  s.background = CONFETTI_COLORS[i % 3];
  $("confetti").appendChild(pc.node);
  pieces.push(pc);
}

// ---- hearts floating out of the Follow chip ----
const HEART_PATH = "M12 21s-7.5-4.6-9.8-9C.6 8.6 2.6 4.5 6.6 4.5c2.3 0 3.8 1.3 5.4 3.2 1.6-1.9 3.1-3.2 5.4-3.2 4 0 6 4.1 4.4 7.5C19.5 16.4 12 21 12 21z";
const hearts = [0, 420, 840, 1260].map((off, i) => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", HEART_PATH);
  path.setAttribute("fill", i % 2 ? th.accent : th.light);
  svg.appendChild(path);
  $("hearts").appendChild(svg);
  return { off, i, node: svg };
});

// ---- alert queue ----
const queue = [];
const seen = new Set(); // TikTok can resend the same follow; alert once per user per session
let current = null; // { start }
let raf = null;

function enqueue(follower) {
  const key = follower.user || follower.nickname;
  if (!key || seen.has(key)) return;
  seen.add(key);
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(follower);
  if (!current) next();
}

function next() {
  const follower = queue.shift();
  if (!follower) {
    current = null;
    el.card.style.opacity = 0;
    cancelAnimationFrame(raf);
    raf = null;
    return;
  }
  const name = follower.nickname || follower.user;
  el.name.textContent = name;
  el.initial.textContent = (Array.from(name)[0] || "?").toUpperCase();
  el.img.classList.remove("loaded");
  el.img.removeAttribute("src");
  if (follower.avatarUrl) el.img.src = follower.avatarUrl;
  current = { start: performance.now() };
  if (!raf) raf = requestAnimationFrame(frame);
}

el.img.addEventListener("load", () => el.img.classList.add("loaded"));
el.img.addEventListener("error", () => el.img.classList.remove("loaded"));

function frame(now) {
  raf = requestAnimationFrame(frame);
  const e = now - current.start;
  if (e >= SHOW_MS + GAP_MS) {
    next();
    return;
  }
  const outAt = SHOW_MS - 500;

  // card pops in with a bounce, then blurs and lifts away
  const ci = seg(e, 0, 700), co = easeIn(seg(e, outAt, 500));
  const cardO = e >= SHOW_MS ? 0 : clamp01(ci * 2.2) * (1 - co);
  const cardY = 28 * (1 - easeOut(ci)) - 18 * co;
  const cardSc = (0.84 + 0.16 * easeBack(ci)) * (1 - 0.06 * co);
  const cardB = 10 * (1 - easeOut(ci)) + 7 * co;
  el.card.style.opacity = r2(cardO);
  el.card.style.transform = "translateY(" + r2(cardY) + "px) scale(" + r2(cardSc) + ")";
  el.card.style.filter = "blur(" + r2(cardB) + "px)";
  el.card.style.setProperty("--glow", r2(0.14 + 0.22 * Math.sin(Math.PI * seg(e, 200, 1400))));

  // avatar spins in, then each text line and the chip rise in turn
  const b = seg(e, 120, 850), bo = easeOut(b), bb = easeBack(b);
  const t1 = easeOut(seg(e, 260, 600)), t2 = easeOut(seg(e, 330, 650)), t3 = easeOut(seg(e, 420, 650));
  const c = seg(e, 480, 700);
  const pb = seg(e, 650, 500);
  const live = seg(e, 900, 300) * (1 - seg(e, outAt - 300, 300));

  el.halo.style.opacity = r2(0.55 + 0.45 * Math.sin(Math.PI * seg(e, 200, 1200)) + 0.1 * Math.sin(now / 600));
  el.shine.style.left = r2(-60 + 190 * easeInOut(seg(e, 500, 1100))) + "%";
  el.bar.style.width = r2(100 * (1 - seg(e, 700, outAt - 700))) + "%";

  // two shockwave rings
  const wave = (node, p, max) => {
    node.style.opacity = r2(p > 0 && p < 1 ? 0.9 * (1 - p) : 0);
    node.style.transform = "scale(" + r2(1 + max * easeOut(p)) + ")";
  };
  wave(el.wave1, seg(e, 380, 800), 0.9);
  wave(el.wave2, seg(e, 520, 900), 1.4);

  const bp = seg(e, 400, 1100);
  const bpo = easeOut(bp);
  for (const pc of pieces) {
    const x = Math.cos(pc.a) * pc.d * bpo;
    const y = Math.sin(pc.a) * pc.d * bpo + 18 * bp * bp;
    pc.node.style.opacity = r2(bp > 0 && bp < 1 ? 1 - Math.pow(bp, 1.6) : 0);
    pc.node.style.transform = "translate(" + r2(x) + "px, " + r2(y) + "px) rotate(" + r2(pc.spin * bp) + "deg) scale(" + r2(1 - 0.4 * bp) + ")";
  }

  look(el.avatar, clamp01(b * 2.5), 0, 4 * (1 - bo), " scale(" + r2(0.3 + 0.7 * bb) + ") rotate(" + r2(-160 * (1 - bo)) + "deg)");
  el.ring.style.background = "conic-gradient(from " + r2((now / 8) % 360) + "deg, " + th.light + ", " + th.accent + ", rgba(" + th.rgb + ", 0.1), " + th.light + ")";
  el.plus.style.opacity = r2(clamp01(pb * 3));
  el.plus.style.transform = "scale(" + r2(easeBack(pb)) + ") rotate(" + r2(-120 * (1 - easeOut(pb))) + "deg)";

  const sparkV = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((now % 1600) / 1600));
  el.spark.style.transform = "scale(" + r2(0.7 + 0.4 * sparkV) + ") rotate(" + r2(90 * sparkV) + "deg)";
  look(el.sub, t1, 18 * (1 - t1), 6 * (1 - t1));
  look(el.name, t2, 22 * (1 - t2), 6 * (1 - t2));
  el.name.style.textShadow = th.ts + ", 0 0 " + r2(14 * Math.sin(Math.PI * seg(e, 900, 1300))) + "px rgba(" + th.rgb + ", 0.9)";
  look(el.thanks, t3, 18 * (1 - t3), 6 * (1 - t3));
  look(el.chip, clamp01(c * 2), 18 * (1 - easeOut(c)), 6 * (1 - easeOut(c)), " scale(" + r2(0.75 + 0.25 * easeBack(c)) + ")");

  const beatP = (now % 1100) / 1100;
  const beat = beatP < 0.18 ? Math.sin(Math.PI * beatP / 0.18) : (beatP < 0.36 ? 0.6 * Math.sin(Math.PI * (beatP - 0.18) / 0.18) : 0);
  el.beat.style.transform = "scale(" + r2(1 + 0.28 * beat) + ")";

  for (const h of hearts) {
    const p = ((e + h.off) % 1680) / 1680;
    const x = [-16, 2, 18, 34][h.i] + Math.sin(p * Math.PI * 2 + h.i * 1.7) * 5;
    const y = -40 * easeOut(p) - 4;
    h.node.style.opacity = r2(Math.sin(Math.PI * p) * live);
    h.node.style.transform = "translate(" + r2(x) + "px, " + r2(y) + "px) scale(" + r2(0.55 + 0.55 * p) + ") rotate(" + r2(Math.sin(p * 6 + h.i) * 14) + "deg)";
  }
}

if (params.get("demo") === "1") {
  const SAMPLE = ["Minnie", "BossKung", "SkyBlue", "FriedFish", "Nutty_TH", "Sprout", "KaoNiew"];
  let n = 0;
  const pushSample = () => {
    // unique key per round so the dedupe doesn't swallow the loop
    enqueue({ user: "demo-" + n, nickname: SAMPLE[n % SAMPLE.length] });
    n++;
  };
  pushSample();
  setInterval(() => { if (!current && !queue.length) pushSample(); }, 500);
} else {
  const setWsStatus = attachStatusIndicator();
  connectWS((data) => {
    if (data.type !== "follow") return;
    enqueue(data);
  }, setWsStatus);
}
