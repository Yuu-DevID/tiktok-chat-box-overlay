const MAX_LINES = 20;
const chatBox = document.getElementById("chat-box");

let ttsEnabled = true;

const SPAM_REPEAT_LIMIT = 3;
const lastCommentByUser = new Map();

function isSpamRepeat(userKey, comment) {
  const prev = lastCommentByUser.get(userKey);
  const count = prev && prev.text === comment ? prev.count + 1 : 1;
  lastCommentByUser.set(userKey, { text: comment, count });
  return count > SPAM_REPEAT_LIMIT;
}

function collapseRepeatsForSpeech(text) {
  const collapsed = (text + " ").replace(
    /(.{1,24}?)\1{2,}/g,
    (_match, group, offset) => group.repeat(offset === 0 ? 2 : 1)
  );
  return text.endsWith(" ") ? collapsed : collapsed.replace(/ $/, "");
}

const BLOCKED_TTS_PATTERN =
  /หี[่-๋]?(?![ก-ฮ])|แตด|[คฆขฅ][่-๋]?ว[่-๋]?ย(?!เขิน)|สั[ดส](?!ส่วน)|เย็ด|เงี่ยน|หำ|ชักว่าว|กระจู๋|มึง|กวนตีน|[ฉช]ิบหาย|เด็กเวร|ซัด|โง่|ปัญญาอ่อน|เ[หช]ี[่้]ย(?!ว|น)|อีดอก|ดอกทอง|(?<!แกง)ก(?:ระ|ะ)หรี่(?!ปั)|ร่าน|ไอ้?สัตว์|ส้นตีน|พ่อง(?!อน|ง|าน)|ไปตาย(?!าย)/;

const BLOCKED_GU_PATTERN = /(?<!ส)กู(?![่-๋]|เกิ|รู|ล|ด)/;
const MENTION_PATTERN = /@\S+/g;

const BLOCKED_LATIN_TTS_PATTERN = /\b(?:hee+|kuy+|kuay+|khuy+|khuay+|kuai|khuai|kvy|kxy|hia+|hiam)\b/i;

const BLOCKED_SPELLED_PATTERN = /(?<![ก-๛])[คฆขฅ][\s.\-_*xX#@!?]+(?:[วw][\s.\-_*xX#@!?]+)?ย(?![ก-๛])/;

function containsBlockedWord(text) {
  const normalized = collapseSpacedSingleChars(text);
  return (
    BLOCKED_TTS_PATTERN.test(text) ||
    BLOCKED_TTS_PATTERN.test(normalized) ||
    BLOCKED_LATIN_TTS_PATTERN.test(normalized) ||
    BLOCKED_SPELLED_PATTERN.test(text) ||
    BLOCKED_GU_PATTERN.test(normalized.replace(MENTION_PATTERN, ""))
  );
}

const MALFORMED_THAI_PATTERN = /[เ-ไ][ัิ-ฺ็-๎]/;

const STACKED_TONE_MARKS_PATTERN = /([่-๋])(?!\1)[่-๋]/;

function isMalformedThai(text) {
  return MALFORMED_THAI_PATTERN.test(text || "") || STACKED_TONE_MARKS_PATTERN.test(text || "");
}

const SONG_COMMAND_PATTERN = /^\s*\/music(?:\s|$)/i;

function isSongRequest(text) {
  return SONG_COMMAND_PATTERN.test(text || "");
}

function collapseSpacedSingleChars(text) {
  const tokens = text.split(/\s+/);
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].length === 1) {
      let j = i;
      let combined = "";
      while (j < tokens.length && tokens[j].length === 1) {
        combined += tokens[j];
        j++;
      }
      result.push(j - i >= 2 ? combined : tokens[i]);
      i = j;
    } else {
      result.push(tokens[i]);
      i++;
    }
  }
  return result.join(" ");
}

const GAY_WORD_PATTERN = /^(?:เกย์?|เก|gay)$/i;

function containsGayWord(text) {
  const normalized = collapseSpacedSingleChars(text);
  return normalized.split(/\s+/).some((word) => GAY_WORD_PATTERN.test(word));
}

function containsMathSymbolSpam(text) {
  return text.includes("+");
}

const GIBBERISH_SPAM_PATTERN = /(.{2,24}?)\1{2,}/;

function isGibberishSpam(collapsedText) {
  const compact = collapsedText.replace(/\s+/g, "");
  const match = compact.match(GIBBERISH_SPAM_PATTERN);
  return !!match && match[0].length >= 12;
}

const HANDLE_DIGITS_SPOKEN = 3;

function sanitizeNicknameForSpeech(nickname) {
  const raw = (nickname || "").trim();

  const handle = /^@?([\p{L}\p{M}]+(?:[\s._-]+[\p{L}\p{M}]+)*)[\s._-]*(\d+)$/u.exec(raw);
  if (handle) {
    const name = handle[1].replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
    return name + handle[2].slice(0, HANDLE_DIGITS_SPOKEN);
  }

  return raw
    .replace(/[^\p{L}\p{M}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const GIBBERISH_MIN_LENGTH = 8;
const GIBBERISH_DIGIT_RATIO = 0.5;

function isAlphanumericGibberish(text) {
  const compact = (text || "").replace(/\s+/g, "");
  if (compact.length < GIBBERISH_MIN_LENGTH) return false;
  if (/[\u0E00-\u0E7F]/.test(compact)) return false;
  const digits = (compact.match(/\d/g) || []).length;
  return digits / compact.length >= GIBBERISH_DIGIT_RATIO;
}

function celebrateGift() {
  if (typeof confetti !== "function") return;
  confetti({
    particleCount: 60,
    spread: 65,
    startVelocity: 45,
    origin: { x: 0.15, y: 0.85 },
    colors: ["#ffd54a", "#ff8a5c", "#ff5b7a", "#7c5cff"],
  });
}

function addChatLine(nickname, comment, avatarUrl) {
  const { line, bubble } = buildLine("", "@" + nickname, avatarUrl, null);
  line.querySelector(".nickname").textContent += " :";
  bubble.innerHTML = `<span class="comment">${escapeHtml(comment)}</span>`;
  pushLine(chatBox, line, MAX_LINES);
}

function addEmoteLine(nickname, emoteImages, avatarUrl) {
  const { line, bubble } = buildLine("emote-line", "@" + nickname, avatarUrl, null);
  line.querySelector(".nickname").textContent += " :";
  for (const src of emoteImages) {
    const img = document.createElement("img");
    img.className = "emote-image";
    img.src = src;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      img.remove();
      if (!bubble.querySelector(".emote-image")) line.remove();
    };
    bubble.appendChild(img);
  }
  pushLine(chatBox, line, MAX_LINES);
}

function addGiftLine(nickname, giftName, repeatCount, avatarUrl, giftImage) {
  const { line, bubble } = buildLine("gift-line", "@" + nickname, avatarUrl, null);
  const times = repeatCount > 1 ? ` <span class="gift-count">x${repeatCount}</span>` : "";
  bubble.innerHTML = `<span class="comment">ส่ง ${escapeHtml(giftName)}${times}</span>`;

  pushLine(chatBox, line, MAX_LINES);
}

const setWsStatus = attachStatusIndicator();

function reportToLiveLog(report) {
  ws.send({ type: "overlay-log", page: location.pathname, ...report });
}

const ws = connectWS((data) => {
  try {
    handleWsMessage(data);
    if (data.logId) reportToLiveLog({ event: "rendered", logId: data.logId, lines: chatBox.children.length });
  } catch (err) {
    console.error("[chat] handler threw for", JSON.stringify(data), err);
    reportToLiveLog({ event: "handler-error", logId: data.logId, error: String(err && err.message) });
  }
}, (connected) => {
  setWsStatus(connected);
  if (connected) reportToLiveLog({ event: "hello", size: `${innerWidth}x${innerHeight}`, userAgent: navigator.userAgent });
});

function handleWsMessage(data) {
  if (data.type === "tts-enabled-state") {
    ttsEnabled = data.enabled;
    if (!ttsEnabled) stopSpeaking();
    return;
  }

  if (data.type === "tts-speed-state") {
    ttsSpeed = data.speed;
    return;
  }

  if (data.type === "tts-read-chance-state") {
    ttsReadChance = data.chance;
    return;
  }

  if (data.type === "gift") {
    addGiftLine(data.nickname, data.giftName, data.repeatCount, data.avatarUrl, data.giftImage);
    celebrateGift();
    const times = data.repeatCount > 1 ? ` ${data.repeatCount} ชิ้น` : "";
    const gifterName = sanitizeNicknameForSpeech(data.nickname);
    speak(`ขอบคุณ ${gifterName} ที่ส่ง ${data.giftName}${times}`.replace(/\s+/g, " "));
    return;
  }

  if (data.type === "member") return;

  if (data.type === "emote") {
    addEmoteLine(data.nickname, data.emoteImages || [], data.avatarUrl);
    return;
  }

  if (data.type !== "chat") return;
  addChatLine(data.nickname, data.comment, data.avatarUrl);
  const userKey = data.user || data.nickname;
  const collapsedComment = collapseRepeatsForSpeech(data.comment);
  const skipReasons = [];
  if (isSpamRepeat(userKey, data.comment)) skipReasons.push("spam-repeat");
  if (containsBlockedWord(data.comment)) skipReasons.push("blocked-word");
  if (containsGayWord(data.comment)) skipReasons.push("gay-word");
  if (isMalformedThai(data.comment)) skipReasons.push("malformed-thai");
  if (containsMathSymbolSpam(data.comment)) skipReasons.push("math-symbol-spam");
  if (isGibberishSpam(collapsedComment)) skipReasons.push("gibberish-spam");
  if (isAlphanumericGibberish(data.comment)) skipReasons.push("alphanumeric-gibberish");
  if (isSongRequest(data.comment)) skipReasons.push("song-request");
  // Rolled last so the log only blames chance for Comments that would
  // otherwise have been read.
  if (!skipReasons.length && Math.random() >= ttsReadChance) skipReasons.push("read-chance");
  if (skipReasons.length) {
    console.warn("[tts] skipped", JSON.stringify({ nickname: data.nickname, user: data.user, comment: data.comment, userKey, skipReasons }));
  } else {
    speak(collapsedComment);
  }
}

const TTS_CHUNK_LIMIT = 200;
const TTS_VOLUME = 0.4;
let ttsSpeed = 1.5;
let ttsReadChance = 1;
const speakQueue = [];
let isSpeaking = false;
let currentAudio = null;
let cancelCurrentWatchdog = null;

function speak(text) {
  if (!ttsEnabled) return;
  speakQueue.push(text);
  if (!isSpeaking) processQueue();
}

function stopSpeaking() {
  speakQueue.length = 0;
  if (cancelCurrentWatchdog) {
    cancelCurrentWatchdog();
    cancelCurrentWatchdog = null;
  }
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  isSpeaking = false;
}

function processQueue() {
  if (speakQueue.length === 0) {
    isSpeaking = false;
    return;
  }
  isSpeaking = true;
  const chunks = splitForTts(speakQueue.shift(), TTS_CHUNK_LIMIT);
  playChunks(chunks, 0, processQueue);
}

function splitForTts(text, maxLen) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const TTS_CHUNK_TIMEOUT_MS = 20000;

function playChunks(chunks, i, onDone) {
  if (i >= chunks.length) {
    onDone();
    return;
  }
  const url = "/tts?text=" + encodeURIComponent(chunks[i]);
  const audio = new Audio(url);
  audio.volume = TTS_VOLUME;
  audio.playbackRate = ttsSpeed;
  currentAudio = audio;

  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    console.warn("TTS chunk timed out, ข้ามท่อนนี้ไป:", chunks[i]);
    next();
  }, TTS_CHUNK_TIMEOUT_MS);
  cancelCurrentWatchdog = () => {
    settled = true;
    clearTimeout(watchdog);
  };

  const next = () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    cancelCurrentWatchdog = null;
    audio.onended = null;
    audio.onerror = null;
    playChunks(chunks, i + 1, onDone);
  };
  audio.onended = next;
  audio.onerror = () => {
    console.warn("Google TTS โหลดเสียงไม่สำเร็จ ข้ามท่อนนี้ไป:", chunks[i]);
    next();
  };
  audio.play().catch((err) => {
    console.warn("audio.play() ถูกบล็อก:", err.name, err.message);
    next();
  });
}
