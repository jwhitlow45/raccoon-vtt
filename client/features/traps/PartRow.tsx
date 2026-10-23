import type { ReactNode } from "react";
import { theme } from "../../lib/theme.ts";

/**
 * One row of a trap part's fields (docs/design-v1-polish.md R3): the
 * fields wrap inside the first cell, and the row's remove holds the
 * second, level with the first line, so a remove never wraps alone under
 * the fields it takes away. `under` takes the row's whole width below
 * both, for a choice too wide to share a line with the remove on a narrow
 * sheet.
 *
 * The fields' box stands at the same place in the tree whatever else the
 * row holds, so a remove or a choice that comes or goes keeps a focused
 * field the same element, with its focus.
 */
export function PartRow(props: { children: ReactNode; end?: ReactNode; under?: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: props.end ? "minmax(0, 1fr) auto" : "minmax(0, 1fr)", alignItems: "start", gap: theme.space(2) }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>{props.children}</div>
      {props.end}
      {props.under ? <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>{props.under}</div> : null}
    </div>
  );
}

/** Parts that belong together, as one part a row never parts: a field and its word, its unit after or its name before ("3 rounds", "DC 15"), or buttons that go together. */
export function Pair(props: { children: ReactNode }) {
  return <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: theme.space(2) }}>{props.children}</span>;
}

/** A pair's word, in the muted text a unit takes. */
export function Words(props: { children: ReactNode }) {
  return <span style={{ color: theme.color.textMuted }}>{props.children}</span>;
}
