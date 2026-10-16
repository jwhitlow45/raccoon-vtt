import { useEffect, useState, type CSSProperties } from "react";
import { theme } from "../lib/theme.ts";

/**
 * The one way the client says it is working (design section 14.1): a
 * spinner and a short sentence, shown only once a wait has lasted
 * SHOW_DELAY_MS, so a quick answer never flashes it. Nothing here animates
 * unless it is on screen, and it is on screen only while something loads.
 * A button that starts slow work says so in its own label instead, at
 * once, and ignores a second tap while it is busy.
 */

export const SHOW_DELAY_MS = 200;

/** True once `active` has stayed true for `ms`. False again the moment it ends. */
export function useDelayed(active: boolean, ms: number = SHOW_DELAY_MS): boolean {
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!active) {
      setDue(false);
      return;
    }
    const timer = setTimeout(() => setDue(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && due;
}

/**
 * A ring with a turning arc. It turns by a CSS animation (globals.css), which
 * runs on the compositor and so keeps turning while the page is busy, and
 * which holds still for people who ask for reduced motion.
 */
export function Spinner(props: { size?: number; label?: string }) {
  const size = props.size ?? 16;
  return (
    <svg
      className="rvtt-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      style={{ flex: "none", display: "block" }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A spinner and a sentence ("Loading the monsters…"), after the delay. The
 * caller keeps it mounted only while something loads, or passes `active`.
 * It is a status, so its words are read out as they change. `live` false
 * draws the same line without that, for a line that changes too often to
 * hear, such as a count of pages, whose owner says its start and its end
 * in a status line of its own.
 */
export function Loading(props: { text: string; detail?: string | null; active?: boolean; delay?: number; live?: boolean; style?: CSSProperties }) {
  const shown = useDelayed(props.active ?? true, props.delay);
  if (!shown) return null;
  return (
    <div
      role={props.live === false ? undefined : "status"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(2),
        color: theme.color.textMuted,
        fontSize: theme.font.body14,
        ...props.style,
      }}
    >
      <Spinner size={18} />
      <span style={{ minWidth: 0 }}>
        {props.text}
        {props.detail ? <span style={{ display: "block", fontSize: theme.font.small }}>{props.detail}</span> : null}
      </span>
    </div>
  );
}
