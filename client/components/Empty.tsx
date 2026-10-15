import type { ReactNode } from "react";
import { theme } from "../lib/theme.ts";

/**
 * What a panel shows with nothing in it yet (docs/design-v1-visual.md
 * 2.3): one sentence at 14 px in muted text that says what will be here
 * and how to add it ("Tap a token to see it here."), and at most one
 * button under it. Every panel's empty state looks the same, so an empty
 * list reads as empty rather than broken.
 */
export function Empty(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: "grid", justifyItems: "start", gap: theme.space(3), padding: `${theme.space(2)}px 0` }}>
      <p style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{props.children}</p>
      {props.action}
    </div>
  );
}
