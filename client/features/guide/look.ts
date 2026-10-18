import type { CSSProperties } from "react";
import { theme } from "../../lib/theme.ts";

/**
 * The docs pages' shared pieces of look, kept apart from the markdown
 * renderer so the Docs page loads without it.
 */

/** A docs page's own title, a step above any heading in it (components/Markdown.tsx GUIDE_HEADING). */
export const DOC_TITLE_SIZE = 40;

/** The small capitals over a title: "Part 2", "Start here", "Example 4.1". */
export const EYEBROW: CSSProperties = {
  display: "block",
  margin: 0,
  fontSize: theme.font.small,
  fontWeight: theme.weight.bold,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: theme.color.accent,
};
