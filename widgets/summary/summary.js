const cardEl = document.getElementById("card");
const statsEl = document.getElementById("stats");
const emptyEl = document.getElementById("empty");
const commentsEl = document.getElementById("stat-comments");
const giftsEl = document.getElementById("stat-gifts");
const viewersEl = document.getElementById("stat-viewers");
const topGifterRow = document.getElementById("top-gifter-row");
const topGifterEl = document.getElementById("stat-top-gifter");

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function render(summary) {
  emptyEl.style.display = "none";
  statsEl.style.display = "flex";

  commentsEl.textContent = formatNumber(summary.comments);
  giftsEl.textContent =
    summary.giftDiamonds > 0
      ? `${formatNumber(summary.gifts)} (${formatNumber(summary.giftDiamonds)} 💎)`
      : formatNumber(summary.gifts);
  viewersEl.textContent = formatNumber(summary.viewers);

  if (summary.topGifter) {
    topGifterRow.style.display = "flex";
    topGifterEl.textContent = `${summary.topGifter.nickname} (${formatNumber(summary.topGifter.diamonds)} 💎)`;
  } else {
    topGifterRow.style.display = "none";
  }

  // Replays the entrance animation on every fresh summary, not just the
  // first one, so re-clicking "Show summary" mid-stream still reads as a
  // deliberate refresh rather than a silent number swap.
  cardEl.classList.remove("show");
  void cardEl.offsetWidth;
  cardEl.classList.add("show");
}

const setWsStatus = attachStatusIndicator();

connectWS((data) => {
  if (data.type !== "summary") return;
  render(data);
}, setWsStatus);
