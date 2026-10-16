import { useState, type CSSProperties, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { Button } from "./Button.tsx";
import { NOTICE_TONES, type NoticeTone } from "./tones.ts";

export type { NoticeTone } from "./tones.ts";

/**
 * One look for toasts and banners (docs/design-v1-visual.md 2.3): info on a
 * raised fill, warning ("Reconnecting…") and danger ("You are offline") on
 * their dark fills with an outline in the tone, and the highlight, cream
 * with ink text, for "You are viewing as Pat". 14 px text, an optional
 * leading mark (the connection dot), and an optional action at the right.
 *
 * The highlight sets `--rvtt-focus` to ink, so a control inside it, such
 * as the preview's Exit, shows a focus ring that reads on cream, where the
 * accent ring would not (globals.css).
 *
 * `float` is for a notice over the map: it adds the floating shadow and
 * stacks in the notice layer under the top bar, which the caller places.
 * An inline notice has no shadow. `role` is the caller's: "status" for
 * news, "alert" for what needs attention now.
 *
 * `compact` is a notice that lasts over the map on a short screen
 * (docs/design-v1-layout-hierarchy.md, the bar dock review's follow-up):
 * one line, its words cut short with an ellipsis, its actions in the same
 * row, and More to read the rest. Taller, a Reconnecting or Starting view
 * notice stood over the tool's buttons and the toolbar of a 480 x 320
 * phone at 130%. The whole text stays in the page, so a screen reader
 * hears all of it either way.
 */
export function Notice(props: {
  tone?: NoticeTone;
  float?: boolean;
  role?: "status" | "alert";
  leading?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const tone = NOTICE_TONES[props.tone ?? "info"];
  const [more, setMore] = useState(false);
  const oneLine = props.compact === true && !more;
  return (
    <div
      role={props.role}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(2),
        padding: props.compact ? `${theme.space(1)}px ${theme.space(2)}px` : `${theme.space(2)}px ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${tone.outline}`,
        background: tone.fill,
        color: tone.text,
        fontSize: theme.font.body14,
        lineHeight: theme.leading.body,
        boxShadow: props.float ? theme.shadow.float : undefined,
        ...(tone.focus ? { ["--rvtt-focus" as string]: tone.focus } : null),
        ...props.style,
      }}
    >
      {props.leading}
      <div style={{ flex: 1, minWidth: 0, ...(oneLine ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : null) }}>{props.children}</div>
      {props.compact ? (
        <Button size="sm" variant="quiet" expanded={more} onClick={() => setMore((m) => !m)} style={{ flex: "none", color: "inherit" }}>
          {more ? "Less" : "More"}
        </Button>
      ) : null}
      {props.action ? <div style={{ flex: "none", display: "flex", gap: theme.space(2) }}>{props.action}</div> : null}
    </div>
  );
}
