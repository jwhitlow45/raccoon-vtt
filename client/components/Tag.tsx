import type { ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { TAG_TONES, type TagTone } from "./tones.ts";

export type { TagTone } from "./tones.ts";

/**
 * A read-only status (docs/design-v1-visual.md 2.3): "Healthy", "Online",
 * "Under fog", "Players here", a legendary counter. A pill with a solid
 * `bg` fill and a 1 px outline in its tone, 13 px weight 600, or 11 px in
 * dense rows such as the tracker's counters. It is not a control, so it
 * needs no 44 px target, and it never wears the accent.
 */
export function Tag(props: {
  tone?: TagTone;
  dense?: boolean;
  title?: string;
  /**
   * The widest it draws, for a tag that holds a name of any length, such as
   * a character's: past it the text is cut with an ellipsis. A tag never
   * wraps, so an unbroken 80 character name would otherwise run out of its
   * row. Pixels where the tag sits in a part sized by its content, such as
   * a row's trailing slot, or "100%" in a row that wraps. The whole text
   * stays in the page, for a screen reader, and in the tooltip, which is
   * the text itself unless `title` says otherwise.
   */
  cut?: number | "100%";
  /** Before the words, at the text's size, such as `hidden` on a row players do not see (docs/design-v1-icons.md 3.1 rule 3). */
  icon?: IconName;
  children: ReactNode;
}) {
  const tone = TAG_TONES[props.tone ?? "muted"];
  const cut = props.cut;
  return (
    <span
      title={props.title ?? (cut !== undefined && typeof props.children === "string" ? props.children : undefined)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flex: cut !== undefined ? "0 1 auto" : "none",
        ...(cut !== undefined ? { minWidth: 0, maxWidth: cut } : {}),
        padding: `1px ${theme.space(2)}px`,
        borderRadius: theme.radius.pill,
        border: `${theme.line.border}px solid ${tone.outline}`,
        background: theme.color.bg,
        color: tone.text,
        fontSize: props.dense ? theme.font.tiny : theme.font.small,
        fontWeight: theme.weight.strong,
        lineHeight: theme.leading.tight,
        whiteSpace: "nowrap",
        ...(props.icon ? { gap: theme.space(1) } : null),
      }}
    >
      {props.icon ? <Icon name={props.icon} size={props.dense ? theme.font.tiny : theme.font.small} /> : null}
      {cut !== undefined ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{props.children}</span> : props.children}
    </span>
  );
}
