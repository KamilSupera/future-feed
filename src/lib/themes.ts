export type ThemeId = "ion" | "solar" | "toxic" | "vapor" | "blood";

export const THEMES: { id: ThemeId; label: string; swatch: string[] }[] = [
  { id: "ion", label: "ION_CYAN", swatch: ["#04070f", "#00e5ff", "#ff2d95"] },
  { id: "solar", label: "SOLAR_RUST", swatch: ["#0f0a06", "#ff7a18", "#ffd479"] },
  { id: "toxic", label: "TOXIC_CIRCUIT", swatch: ["#05070a", "#39ff14", "#ffb200"] },
  { id: "vapor", label: "VAPOR_CHROME", swatch: ["#0a0618", "#a78bfa", "#67e8f9"] },
  { id: "blood", label: "BLOOD_NEON", swatch: ["#0d0d0f", "#ff2d3f", "#e6f0ff"] },
];

export const DEFAULT_THEME: ThemeId = "ion";
export const THEME_STORAGE_KEY = "orbital-theme";
