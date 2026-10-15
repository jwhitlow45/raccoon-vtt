import type { ReactNode } from "react";
import { theme } from "../../lib/theme.ts";

/**
 * The last row of a pane over the map (the label, pin and light panes):
 * what removes the thing at the left, the pane's one main action at the
 * right, so Delete and Done never sit side by side.
 */
export function PaneFooter(props: { children: ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: theme.space(2), marginTop: theme.space(1) }}>{props.children}</div>;
}
