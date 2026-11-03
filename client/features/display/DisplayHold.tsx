import { useLayoutEffect, type ReactNode } from "react";
import { holdForPage } from "../../lib/scheme.ts";

/**
 * The table display shows the board's dark look whatever this device chose
 * (D-261102-364). The hold stands in App's display route, outside the lazy
 * pages it wraps, so the frames while their code loads are dark too, and
 * a layout effect takes it before the route's first paint. On a fresh
 * load main.tsx holds from boot, and this hold takes over from that one.
 * Letting go gives back the device's latest choice, a change made in
 * another window meanwhile included.
 */
export function DisplayHold(props: { children: ReactNode }) {
  useLayoutEffect(holdDark, []);
  return props.children;
}

function holdDark(): () => void {
  return holdForPage("dark");
}
