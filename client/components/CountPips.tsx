import type { ReactNode } from "react";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";

/**
 * The most a count shows as pips (D-261026-2). Counts that top out at 6,
 * such as Rage at level 17 or the Tarrasque's Legendary Resistance, then
 * stay pips all campaign, and 6 pips still fit beside a short name in the
 * narrowest uses line, a tracker row's at 320 px wide and 130%. A count of
 * 20 would not, so a larger count keeps its words. A pool, spent by an
 * amount, shows its words at any size (`words`).
 */
export const PIPS_MOST = 6;

export type Count = { left: number; max: number };

/** What the pips say to a screen reader, after the name they stand beside: "2 of 3 left". */
export function countWords(count: Count): string {
  return `${count.left} of ${count.max} left`;
}

/**
 * A use's name line (docs/design-v1-monster-uses.md 3.1): the name at its
 * left, in bold, and `end` at its right end, a count's pips or a
 * recharge's state. `spoken` follows the name for a screen reader, since
 * `end` is hidden from it.
 *
 * The name takes what `end` leaves and wraps beside it. Only its longest
 * word counts toward sharing the line (`min-content`), so `end` drops to
 * the next line, as one part at its right end, only where that word and
 * `end` cannot stand side by side. A share of the line as the name's basis
 * would drop 6 pips under every name at 320 px and 130%, and its whole
 * width would drop 3 pips under "Legendary Resistance" there.
 * `break-word`, unlike `anywhere`, leaves the longest word as the name's
 * `min-content`, and still breaks a word longer than the whole line.
 * `end` that drops stands right under the name with no gap, as a second
 * line of the name would, so the row is as tall as one whose name wraps
 * beside its end (the alignment sweep's kind-height on a turn card at
 * 320 px and 130%, a recharge's "Rolled 5: ready" beside Legendary
 * Resistance's two lines).
 */
export function NameLine(props: { name: ReactNode; spoken?: string; end?: ReactNode }) {
  return (
    <div style={{ flex: "1 1 100%", minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: 0, fontSize: theme.font.input, lineHeight: theme.leading.tight }}>
      <span style={{ position: "relative", flex: "1 1 auto", width: "min-content", minWidth: 0, overflowWrap: "break-word", fontWeight: theme.weight.strong }}>
        {/* The name in an element of its own, so a search by its words alone still finds it beside the spoken count. */}
        <span>{props.name}</span>
        {props.spoken ? <span style={VISUALLY_HIDDEN}>{`, ${props.spoken}`}</span> : null}
      </span>
      {props.end}
    </div>
  );
}

/** A pip's size, its ring and the room between two pips, in px. */
const PIP = 14;
const PIP_RING = theme.line.strong;
const PIP_GAP = theme.space(1);

/**
 * A count to read, never to tap: a pip for each use, filled for each one
 * left, from the left, as "2 of 3" left read before. Past PIPS_MOST, or
 * where `words` asks for them (a pool, spent by an amount), its words,
 * "7 of 10", where the pips would stand. Hidden from a screen
 * reader, which hears `countWords` after the name instead. One picture,
 * as an icon is, so the row reads as its name beside a mark and not as a
 * row of boxes.
 */
export function CountPips(props: Count & { words?: boolean }) {
  if (props.words || props.max > PIPS_MOST) return <EndWords>{`${props.left} of ${props.max}`}</EndWords>;
  const width = props.max * PIP + (props.max - 1) * PIP_GAP;
  return (
    <svg data-use-pips="" aria-hidden="true" width={width} height={PIP} viewBox={`0 0 ${width} ${PIP}`} style={{ flex: "none", marginLeft: "auto", display: "block", overflow: "visible" }}>
      {Array.from({ length: props.max }, (_, i) => (
        <circle
          key={i}
          data-pip={i < props.left ? "left" : "spent"}
          cx={i * (PIP + PIP_GAP) + PIP / 2}
          cy={PIP / 2}
          r={(PIP - PIP_RING) / 2}
          strokeWidth={PIP_RING}
          style={{ stroke: theme.color.accent, fill: i < props.left ? theme.color.accent : "none" }}
        />
      ))}
    </svg>
  );
}

/** Muted words at the right end of a name line, where pips would stand: a count past PIPS_MOST or a pool's, or a recharge's state. They drop as one part, never breaking inside "20 of 25". */
export function EndWords(props: { children: string }) {
  return (
    <span data-use-pips="" aria-hidden="true" style={{ flex: "none", marginLeft: "auto", whiteSpace: "nowrap", color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>
      {props.children}
    </span>
  );
}
