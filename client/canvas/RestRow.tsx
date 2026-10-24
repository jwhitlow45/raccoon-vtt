import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { restOrder } from "./barDock.ts";
import { restFit } from "./barButtons.ts";

/** One candidate of the quick row: its id in the strip's order (barDock.ts restOrder) and what it draws. */
export type RestItem = { id: string; node: ReactNode };

/** The HP field's least width in the lead (docs/design-v1-bar-compact.md R14). */
const FIELD_MIN = 56;

/**
 * How far the focus ring reaches past a control: its 2 px outline and its
 * 2 px offset (globals.css :focus-visible). The row clips what does not
 * fit, so it reaches this far past its own edges, padded and pulled back
 * by as much, and a control's ring shows whole.
 */
const RING_ROOM = 4;

/** A candidate that does not fit: out of the row's flow and unseen, but mounted and measured where it stands. */
const SKIPPED: CSSProperties = { position: "absolute", left: 0, top: 0, visibility: "hidden", pointerEvents: "none" };

/**
 * The resting strip's quick row (docs/design-v1-bar-compact.md 3.3): one
 * 44 px line that never wraps, in the strip's order on screen. Which
 * candidates show is the fit rule's (barButtons.ts restFit), read from
 * each one's drawn width, so the font, the interface size and the
 * browser's least font size count. "mode", the HP entry's lead, takes the
 * room the actions after it leave, its field never under 56 px. The lead's
 * field is the element marked `data-rest-field`, or else its input. The
 * ids are the bar's buttons (barButtons.ts BarButtonId), "details",
 * "crit", "useRoll" and "mode", a token's or a group's.
 *
 * Every node stays mounted once, under a wrapper keyed by its id, so the
 * HP field keeps what was typed, its caret and focus through Expand and
 * Collapse. A candidate that does not fit is measured where it stands,
 * out of the row's flow and unseen, which also takes it out of the focus
 * order and the accessibility tree. `onFit` hears the ids shown, in
 * order, whenever they change.
 */
export function RestRow(props: { items: readonly RestItem[]; onFit?(shown: readonly string[]): void }) {
  const byId = new Map(props.items.map((item) => [item.id, item]));
  const order = restOrder([...byId.keys()]);
  const orderKey = order.join(" ");
  const rowRef = useRef<HTMLDivElement>(null);
  // Null until the first measure, which runs before the browser paints.
  const [shown, setShown] = useState<readonly string[] | null>(null);
  const [measures, setMeasures] = useState(0);
  const onFit = useRef(props.onFit);
  onFit.current = props.onFit;
  const told = useRef<string | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // Every width as drawn, in screen px, so the chrome's zoom scales the room, the gap and the field's least alike. The room is the row's less the ring's on each side.
    const drawn = row.getBoundingClientRect().width;
    const scale = row.offsetWidth > 0 ? drawn / row.offsetWidth : 1;
    const rowWidth = Math.max(0, drawn - 2 * RING_ROOM * scale);
    const widths: Record<string, number> = {};
    for (const el of row.querySelectorAll<HTMLElement>(":scope > [data-rest-item]")) {
      const id = el.dataset.restItem;
      if (id === undefined) continue;
      const width = el.getBoundingClientRect().width;
      if (id !== "mode") {
        widths[id] = width;
        continue;
      }
      // The lead counts without its field, which the fit gives its least. Drawn squeezed, as on the first render where every
      // candidate is drawn, its parts overflow its box at the field's least, so its scroll width is its natural one, and the
      // fit never reads a squeezed lead as room for more.
      const field = el.querySelector<HTMLElement>("[data-rest-field]") ?? el.querySelector<HTMLElement>("input");
      const natural = el.scrollWidth > el.clientWidth + 1 ? el.scrollWidth * scale : width;
      widths[id] = Math.max(0, natural - (field?.getBoundingClientRect().width ?? 0));
    }
    const fit = restFit(widths, rowWidth, theme.space(1) * scale, FIELD_MIN * scale);
    setShown((prev) => (prev !== null && prev.length === fit.length && prev.every((id, i) => id === fit[i]) ? prev : fit));
  }, [orderKey, measures]);
  // A width that changes after, as a font arriving, a chip's words or the row's own width, fits the row again.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => setMeasures((n) => n + 1));
    observer.observe(row);
    for (const el of row.querySelectorAll(":scope > [data-rest-item]")) observer.observe(el);
    return () => observer.disconnect();
  }, [orderKey]);
  useLayoutEffect(() => {
    if (shown === null) return;
    const key = shown.join(" ");
    if (told.current === key) return;
    told.current = key;
    onFit.current?.(shown);
  }, [shown]);

  const showing = new Set(shown ?? order);
  return (
    <div
      data-rest-row=""
      ref={rowRef}
      style={{ position: "relative", display: "flex", flexWrap: "nowrap", alignItems: "center", gap: theme.space(1), minWidth: 0, minHeight: theme.touch + 2 * RING_ROOM, padding: RING_ROOM, margin: -RING_ROOM, overflow: "hidden" }}
    >
      {order.map((id) => {
        const on = showing.has(id);
        return (
          <div key={id} data-rest-item={id} data-rest-shown={on ? "" : undefined} style={on ? { display: "flex", flex: id === "mode" ? "1 1 0" : "none", minWidth: 0 } : { display: "flex", ...SKIPPED }}>
            {byId.get(id)?.node}
          </div>
        );
      })}
    </div>
  );
}
