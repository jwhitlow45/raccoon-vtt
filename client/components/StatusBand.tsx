import { theme } from "../lib/theme.ts";

/**
 * The iPhone home-screen app's black strip under its status bar on a light
 * page (docs/design/design-v1-light-theme.md 6.4). index.html asks for
 * `black-translucent`, read only at launch, so iOS draws white status text
 * over whatever the page shows there. lib/scheme.ts sets
 * `--rvtt-status-band` to black only in that app on a light page, and
 * leaves it transparent everywhere else. App.tsx draws it once, over
 * every page and everything outside the top layer, so no bar, sheet or
 * popover fallback covers it. A dialog in the top layer draws its own
 * (components/Dialog.tsx). Taps pass through it.
 */
export function StatusBand() {
  return (
    <div
      aria-hidden
      data-rvtt-status-band=""
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: theme.safe.top,
        zIndex: theme.z.statusBand,
        pointerEvents: "none",
        background: "var(--rvtt-status-band, transparent)",
      }}
    />
  );
}
