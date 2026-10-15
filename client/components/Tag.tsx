import type { ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { TAG_TONES, type TagTone } from "./tones.ts";

export type { TagTone } from "./tones.ts";

/**
 * A read-only status (docs/design-v1-visual.md 2.3): "Healthy", "Online",
 * "Under fog", "Players here", a legendary counter. A pill with a solid
 * `bg` fill and a 1 px outline in its tone, 13 px weight 600, or 11 px in
 * dense rows such as the tracker's counters. It is not a control, so it
 * needs no 44 px target, and it never wears the accent.
 */
export function Tag(props: { tone?: TagTone; dense?: boolean; title?: string; children: ReactNode }) {
  const tone = TAG_TONES[props.tone ?? "muted"];
  return (
    <span
      title={props.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flex: "none",
        padding: `1px ${theme.space(2)}px`,
        borderRadius: theme.radius.pill,
        border: `${theme.line.border}px solid ${tone.outline}`,
        background: theme.color.bg,
        color: tone.text,
        fontSize: props.dense ? theme.font.tiny : theme.font.small,
        fontWeight: theme.weight.strong,
        lineHeight: theme.leading.tight,
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </span>
  );
}
