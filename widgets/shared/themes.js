// Card color themes shared by the overlay cards (top-donate, timer).
// Pick one with ?theme=<name>; defaults to midnight.
const THEMES = {
  midnight: { bg: "rgba(26, 19, 48, 0.78)", border: "rgba(255, 255, 255, 0.14)", text: "#F6F3FF", sub: "rgba(246, 243, 255, 0.68)", baht: "#2BD9E6", accent: "#FF4D7A", chipBg: "rgba(255, 255, 255, 0.1)", chipFg: "#F6F3FF" },
  ocean:    { bg: "rgba(14, 30, 56, 0.8)", border: "rgba(125, 211, 252, 0.12)", text: "#FFFFFF", sub: "#9DB5D3", baht: "#7DD3FC", accent: "#38BDF8", chipBg: "rgba(125, 211, 252, 0.12)", chipFg: "#E0F2FE" },
  berry:    { bg: "rgba(58, 20, 44, 0.8)", border: "rgba(253, 164, 200, 0.12)", text: "#FFFFFF", sub: "#D8A9C1", baht: "#FDA4C8", accent: "#F472B6", chipBg: "rgba(253, 164, 200, 0.12)", chipFg: "#FCE7F3" },
  emerald:  { bg: "rgba(10, 44, 38, 0.8)", border: "rgba(110, 231, 183, 0.12)", text: "#FFFFFF", sub: "#9CC9BA", baht: "#6EE7B7", accent: "#34D399", chipBg: "rgba(110, 231, 183, 0.12)", chipFg: "#D1FAE5" },
  sunset:   { bg: "rgba(50, 30, 18, 0.8)", border: "rgba(252, 211, 77, 0.12)", text: "#FFFFFF", sub: "#D3B79A", baht: "#FCD34D", accent: "#F59E0B", chipBg: "rgba(252, 211, 77, 0.12)", chipFg: "#FEF3C7" },
  frost:    { bg: "rgba(255, 255, 255, 0.72)", border: "rgba(255, 255, 255, 0.9)", text: "#1F1B2E", sub: "#5F5975", baht: "#6D4AE8", accent: "#7C5CFF", chipBg: "rgba(31, 27, 46, 0.08)", chipFg: "#1F1B2E" },
};

// Writes the chosen theme's colors as CSS variables on :root.
function applyTheme(name) {
  const theme = THEMES[name] || THEMES.midnight;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--bg", theme.bg);
  rootStyle.setProperty("--border", theme.border);
  rootStyle.setProperty("--text", theme.text);
  rootStyle.setProperty("--sub", theme.sub);
  rootStyle.setProperty("--baht", theme.baht);
  rootStyle.setProperty("--accent", theme.accent);
  rootStyle.setProperty("--chip-bg", theme.chipBg);
  rootStyle.setProperty("--chip-fg", theme.chipFg);
  return theme;
}
