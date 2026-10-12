/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // DS-FE-001 AC-31: semantic tokens only. Components never hardcode
        // absolute light/dark values, so a dark theme is a token swap later.
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Workspace-specific surface tokens
        // Translucent so the shell's light field shows through the reading area.
        workspace: "var(--workspace-bg)",
        "page-surface": "hsl(var(--page-surface))",
        // Status colours used as text. Tokens rather than a fixed amber/emerald
        // step, because the step that reads on white does not read on dark.
        warning: "hsl(var(--warning-text))",
        success: "hsl(var(--success-text))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontSize: {
        // Desktop-tool density: nothing larger than text-lg in the shell.
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      transitionTimingFunction: {
        // iOS-style motion: a spring that overshoots a touch, and a long ease-out.
        spring: "cubic-bezier(.34,1.56,.64,1)",
        glass: "cubic-bezier(.32,.72,0,1)",
      },
      keyframes: {
        "pane-in": {
          from: { opacity: "0", transform: "translateY(12px) scale(.985)", filter: "blur(6px)" },
          to: { opacity: "1", transform: "none", filter: "none" },
        },
        rise: {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "none" },
        },
        pop: {
          from: { opacity: "0", transform: "translateY(8px) scale(.9)" },
          to: { opacity: "1", transform: "none" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pane-in": "pane-in .55s cubic-bezier(.32,.72,0,1) backwards",
        rise: "rise .7s cubic-bezier(.32,.72,0,1) backwards",
        pop: "pop .55s cubic-bezier(.34,1.56,.64,1) backwards",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
