export const themes = [
  { id: "ark-dark", name: "Ark Dark", group: "dark", description: "Neutral charcoal with mint accents", colors: ["#0d0d0e", "#181819", "#a7f3d0"] },
  { id: "graphite", name: "Graphite", group: "dark", description: "Soft gray with amber accents", colors: ["#151515", "#242424", "#f4c97a"] },
  { id: "midnight", name: "Midnight", group: "dark", description: "Deep navy with blue accents", colors: ["#090d18", "#121a2b", "#8ab4ff"] },
  { id: "paper", name: "Paper", group: "light", description: "Warm paper with forest accents", colors: ["#f4f1e8", "#fffdf7", "#287052"] },
  { id: "snow", name: "Snow", group: "light", description: "Cool white with indigo accents", colors: ["#f4f6fa", "#ffffff", "#5267d9"] },
] as const;

export type ThemeId = (typeof themes)[number]["id"];

export function applyTheme(themeId: string): ThemeId {
  const theme = themes.find((item) => item.id === themeId) || themes[0];
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.themeGroup = theme.group;
  document.documentElement.style.colorScheme = theme.group;
  localStorage.setItem("pi-ark-theme", theme.id);
  return theme.id;
}

export function applyStoredTheme(): void {
  applyTheme(localStorage.getItem("pi-ark-theme") || "ark-dark");
}
