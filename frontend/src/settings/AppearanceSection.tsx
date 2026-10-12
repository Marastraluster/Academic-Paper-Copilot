/**
 * 设置 · 外观 — light, dark, or the system's own choice.
 */
import { useState } from "react";
import { SunMoon } from "lucide-react";

import { cn } from "@/lib/utils";
import { readTheme, setTheme, THEME_CHOICES, type ThemeChoice } from "@/settings/theme";

export function AppearanceSection() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme());

  return (
    <section data-testid="settings-appearance" className="space-y-2 border-t pt-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <SunMoon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        外观
      </h3>
      <div role="radiogroup" aria-label="主题" className="glass-track inline-flex rounded-full p-[3px]">
        {THEME_CHOICES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="radio"
            aria-checked={choice === entry.value}
            data-testid={`theme-${entry.value}`}
            onClick={() => {
              setChoice(entry.value);
              setTheme(entry.value);
            }}
            className={cn(
              "h-7 rounded-full px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              choice === entry.value
                ? "glass-thumb font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        深色主题只改变界面。论文页面始终按原样（白底）显示。
      </p>
    </section>
  );
}
