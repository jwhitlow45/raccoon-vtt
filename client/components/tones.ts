import { theme } from "../lib/theme.ts";

/**
 * The fixed tone colors of status marks (docs/design-v1-visual.md 2.3).
 * A status never wears the accent: it means the same to every member,
 * whatever color they picked.
 */

export type TagTone = "success" | "warning" | "danger" | "muted" | "turn";

/**
 * A Tag's outline and text, on a solid `bg` fill. The fill is solid, so
 * the text reads the same on any row, the tinted turn row included, and
 * each text color is checked against `bg` at 4.5:1 (controls.test.ts).
 */
export const TAG_TONES: Record<TagTone, { outline: string; text: string }> = {
  success: { outline: theme.color.success, text: theme.color.success },
  warning: { outline: theme.color.warning, text: theme.color.warning },
  danger: { outline: theme.color.danger, text: theme.color.dangerText },
  muted: { outline: theme.color.border, text: theme.color.textMuted },
  turn: { outline: theme.color.accentSoft, text: theme.color.accentSoft },
};

export type NoticeTone = "info" | "warning" | "danger" | "highlight";

/**
 * A Notice's fill, outline and text. `focus` is the focus ring inside it,
 * set as `--rvtt-focus` (globals.css): on the cream highlight the accent
 * ring would vanish (the crest yellow reads 1.1:1 there), so it is ink.
 */
export const NOTICE_TONES: Record<NoticeTone, { fill: string; outline: string; text: string; focus?: string }> = {
  info: { fill: theme.color.surfaceRaised, outline: theme.color.border, text: theme.color.text },
  warning: { fill: theme.color.warningFill, outline: theme.color.warning, text: theme.color.text },
  danger: { fill: theme.color.dangerFill, outline: theme.color.danger, text: theme.color.text },
  highlight: { fill: theme.color.accentSoft, outline: theme.color.accentSoft, text: theme.color.ink, focus: theme.color.ink },
};
