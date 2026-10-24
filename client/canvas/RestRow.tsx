import type { ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { restOrder } from "./barDock.ts";

/** One candidate of the quick row: its id in the strip's order (barDock.ts restOrder) and what it draws. */
export type RestItem = { id: string; node: ReactNode };

/**
 * The resting strip's quick row (docs/design-v1-bar-compact.md 3.3): one
 * 44 px line that never wraps, in the strip's order on screen. "mode",
 * the HP entry's lead, takes the room the actions after it leave. The ids
 * are the bar's buttons (barButtons.ts BarButtonId), "details", "crit",
 * "useRoll" and "mode", a token's or a group's.
 */
export function RestRow(props: { items: readonly RestItem[] }) {
  const byId = new Map(props.items.map((item) => [item.id, item]));
  const shown = restOrder(props.items.map((item) => item.id));
  return (
    <div data-rest-row="" style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: theme.space(1), minWidth: 0, minHeight: 44, overflow: "hidden" }}>
      {shown.map((id) => (
        <div key={id} data-rest-item={id} style={{ display: "flex", flex: id === "mode" ? "1 1 auto" : "none", minWidth: 0 }}>
          {byId.get(id)?.node}
        </div>
      ))}
    </div>
  );
}
