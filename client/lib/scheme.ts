import { useSyncExternalStore } from "react";
import { THEME_KEY, themeChoice, themeChoiceSetting, type ThemeChoice } from "../features/device/settings.ts";
import { accentFor, baseAccentVars } from "./accent.ts";
import { paletteVars, PALETTES, theme, type Scheme } from "./theme.ts";

/**
 * The page's scheme (docs/design/design-v1-light-theme.md 6.2): the
 * device's Theme choice (features/device/settings.ts) resolved to dark or
 * light, Auto through the device's own `prefers-color-scheme`. A change
 * writes the scheme's palette, its shadows and its crest accent on the
 * document's root as custom properties, which every `theme.color` token
 * reads, so the whole page follows with no re-render and no reload. The
 * board reads `boardTheme` and never follows.
 *
 * Every open window of the app follows a change made in another, through
 * the `storage` event, and a page that keeps one look (the table display)
 * holds dark and gives back the device's latest choice when it lets go.
 */

const LIGHT_QUERY = "(prefers-color-scheme: light)";

const listeners = new Set<() => void>();
/** What pages that keep one look hold, newest last (`holdScheme`). */
const holds: { scheme: Scheme }[] = [];
let current: Scheme = "dark";
let started = false;

function systemLight(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

/** The scheme a choice shows, Auto by the device's own setting. */
export function resolveScheme(choice: ThemeChoice, systemPrefersLight: boolean): Scheme {
  if (choice === "auto") return systemPrefersLight ? "light" : "dark";
  return choice;
}

function resolved(): Scheme {
  return holds.at(-1)?.scheme ?? resolveScheme(themeChoice(), systemLight());
}

/**
 * Whether the iPhone home-screen app draws its status bar's white text over
 * this page: index.html asks for `black-translucent`, read only at launch,
 * so a light page needs a black strip under it (`statusBand` in theme.ts).
 */
function standalone(): boolean {
  return typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** The custom properties and attributes the root takes for a scheme, apart from the document, so a test can read them. */
export function rootLook(scheme: Scheme, inStandaloneApp: boolean): { vars: Record<string, string>; colorScheme: Scheme; themeColor: string } {
  return {
    vars: {
      ...paletteVars(scheme),
      ...baseAccentVars(accentFor(null, scheme)),
      "--rvtt-status-band": inStandaloneApp && scheme === "light" ? theme.color.stage : "transparent",
    },
    colorScheme: scheme,
    themeColor: PALETTES[scheme].bg,
  };
}

function paint(): void {
  const next = resolved();
  const changed = next !== current;
  current = next;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const look = rootLook(next, standalone());
    for (const [name, value] of Object.entries(look.vars)) root.style.setProperty(name, value);
    // Native controls and scrollbars follow, over globals.css's dark boot default.
    root.style.colorScheme = look.colorScheme;
    root.dataset.rvttScheme = next;
    // Android and Safari tabs tint their bars from it. The manifest's colors stay dark, for the splash screen.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", look.themeColor);
  }
  if (changed) for (const listener of listeners) listener();
}

/**
 * Colors the page from the stored choice and follows every later change:
 * a choice made here, one made in another window, and the device's own
 * setting while Auto is chosen. client/main.tsx runs it before the first
 * render. A second call does nothing.
 */
export function startScheme(): void {
  if (started) return;
  started = true;
  themeChoiceSetting.subscribe(paint);
  try {
    if (typeof matchMedia === "function") matchMedia(LIGHT_QUERY).addEventListener("change", paint);
  } catch {
    // A browser with no media query events keeps Auto as it was at load.
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      // A null key is another window clearing all storage, which leaves the default.
      if (event.key === THEME_KEY || event.key === null) themeChoiceSetting.adopt(event.key === null ? null : event.newValue);
    });
  }
  paint();
}

/**
 * Keeps this page in one scheme whatever the device's choice, as the table
 * display keeps dark for its page. The returned release gives back the
 * device's latest choice, one made in another window meanwhile included.
 * A second release does nothing.
 */
export function holdScheme(scheme: Scheme): () => void {
  const hold = { scheme };
  holds.push(hold);
  paint();
  return () => {
    const at = holds.indexOf(hold);
    if (at < 0) return;
    holds.splice(at, 1);
    paint();
  };
}

/** The hold `holdAtBoot` took, until the page's own takes over. */
let bootRelease: (() => void) | null = null;

/**
 * Holds a scheme from before the first render, for a page that keeps one
 * look and whose own code loads after it, as the table display's pages
 * are a lazy chunk: client/main.tsx takes it on that page's path, so the
 * device's scheme never paints a frame there. The page's own hold
 * (`holdForPage`) lets it go once it stands.
 */
export function holdAtBoot(held: Scheme): void {
  bootRelease ??= holdScheme(held);
}

/** A page's own hold, which takes over from the boot hold. Returns its release. */
export function holdForPage(held: Scheme): () => void {
  const release = holdScheme(held);
  bootRelease?.();
  bootRelease = null;
  return release;
}

/** The scheme the page shows now. Dark before `startScheme`, as the tokens' fallbacks are. */
export function scheme(): Scheme {
  return current;
}

export function subscribeScheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The scheme the page shows, for the few places that compute a color from it (lib/accent.ts `accentFor`, `memberInk`). Dark in a render outside the browser. */
export function useScheme(): Scheme {
  return useSyncExternalStore(subscribeScheme, scheme, () => "dark");
}
