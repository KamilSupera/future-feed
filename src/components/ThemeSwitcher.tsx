import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY, type ThemeId } from "@/lib/themes";

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    if (stored && THEMES.some((t) => t.id === stored)) setTheme(stored);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const active = THEMES.find((t) => t.id === theme) ?? THEMES[0]!;

  const pick = (id: ThemeId) => {
    setTheme(id);
    localStorage.setItem(THEME_STORAGE_KEY, id);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Change color palette"
        aria-expanded={open}
        className="flex items-center gap-2 border border-primary/40 bg-primary/5 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary/15"
      >
        <span className="flex">
          {active.swatch.map((c) => (
            <span
              key={c}
              className="size-3 border border-primary/30"
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
        <span className="hidden sm:inline">{active.label}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 border border-primary/40 bg-card p-1 shadow-[var(--glow-primary)]">
          <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-primary/50">
            PALETTE_BANK
          </div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className={`flex w-full items-center gap-2 px-2 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors ${
                t.id === theme
                  ? "bg-primary text-primary-foreground"
                  : "text-primary/70 hover:bg-primary/10"
              }`}
            >
              <span className="flex shrink-0">
                {t.swatch.map((c) => (
                  <span
                    key={c}
                    className="size-3 border border-primary/20"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </span>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
