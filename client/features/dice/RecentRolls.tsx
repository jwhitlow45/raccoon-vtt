import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { formatFormula, parseFormula } from "#shared/dice/formula.ts";
import { hitOf, naturalOf, rolledTerms } from "#shared/dice/roll.ts";
import { creatureName, describeEvent, diceText, memberName, type LogNames } from "#shared/logText.ts";
import type { DiceResult, DiceRoll, LogEntry } from "#shared/model.ts";
import type { DiceRollInput } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { usePanelHere } from "../panels.ts";
import { askedFormula, recentRolls, type RecentRow } from "./logic.ts";

/**
 * Recent rolls (docs/design-v1-dice.md 8.3): every roll in the viewer's
 * log, newest first, one row per roller and batch, with what each drew.
 * Its foot opens the Log, which holds the older ones.
 */

const EMPTY_LOG: LogEntry[] = [];
/** Rolls a row lists before "Show all". */
const FOLDED = 5;

/**
 * The faces of one roll as chips: a dropped die struck through, a natural
 * 20 or 1 marked. Text for a screen reader beside them. `oneLine` keeps
 * them on one line for the sticky line, which clips what does not fit
 * rather than growing over the panel (docs/design-v1-dice.md 8.2).
 */
export function DiceFaces(props: { result: Pick<DiceResult, "formula" | "faces" | "total" | "mode">; oneLine?: boolean }) {
  const terms = rolledTerms(props.result);
  const natural = naturalOf(props.result);
  if (!terms) return <span style={{ color: theme.color.textMuted }}>{props.result.formula}</span>;
  const chips = terms.flatMap((t, ti) =>
    "kept" in t
      ? t.faces.map((face, i) => {
          const dropped = !t.kept[i];
          const nat = !dropped && t.term.sides === 20 && natural !== null && face === natural;
          const style: CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 24,
            height: 24,
            padding: `0 ${theme.space(1)}px`,
            borderRadius: theme.radius.sm,
            fontSize: theme.font.small,
            fontWeight: theme.weight.strong,
            border: `${theme.line.border}px solid ${nat ? (face === 20 ? theme.color.accent : theme.color.danger) : theme.color.border}`,
            color: dropped ? theme.color.textDisabled : theme.color.text,
            textDecoration: dropped ? "line-through" : undefined,
            background: theme.color.surfaceRaised,
          };
          return (
            <span key={`${ti}:${i}`} style={style}>
              {face.toLocaleString("en-US")}
            </span>
          );
        })
      : [],
  );
  return (
    <span style={{ display: "inline-flex", flexWrap: props.oneLine ? "nowrap" : "wrap", gap: theme.space(1), alignItems: "center" }}>
      <span aria-hidden="true" style={{ display: "contents" }}>
        {chips}
      </span>
      <span style={visuallyHidden}>{diceText(props.result)}</span>
    </span>
  );
}

const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

/** "Natural 20", "Critical hit", "Hit", "Miss", "Pass" or "Fail": what a roll's d20 or its DC or AC says. */
export function rollVerdict(roll: DiceRoll, row: { dc?: number; ac?: number }): string | null {
  if (row.ac !== undefined) {
    const hit = hitOf(roll, row.ac);
    return hit === "critical" ? "Critical hit" : hit === "hit" ? "Hit" : "Miss";
  }
  const natural = naturalOf(roll);
  const verdict = row.dc !== undefined ? (roll.fails || roll.total < row.dc ? "Fail" : "Pass") : null;
  const nat = natural === 20 ? "Natural 20" : natural === 1 ? "Natural 1" : null;
  return [nat, verdict].filter(Boolean).join(", ") || null;
}

/**
 * One roll of a row: its total, its creature and label, its dice and its
 * verdict. `lead` goes before them, a single roll's roller, and `end` after,
 * at the line's far end, the row's Again, so a row of one roll takes one or
 * two lines rather than three.
 */
function RollLine(props: { roll: DiceRoll; row: { dc?: number; ac?: number }; names: LogNames; lead?: ReactNode; end?: ReactNode }) {
  const { roll } = props;
  const creature = roll.tokenId !== undefined || roll.characterId !== undefined ? creatureName(props.names, roll) : null;
  const what = [creature, roll.label].filter(Boolean).join(", ");
  const verdict = rollVerdict(roll, props.row);
  const parsed = parseFormula(roll.formula);
  const formula = parsed.ok ? formatFormula(parsed.formula, roll.mode) : roll.formula;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1) }}>
      {props.lead}
      <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, minWidth: 28 }}>{roll.total.toLocaleString("en-US")}</span>
      {what ? <span style={{ fontSize: theme.font.body14, overflowWrap: "anywhere" }}>{what}</span> : null}
      <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{formula}</span>
      <DiceFaces result={roll} />
      {verdict ? <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>{verdict}</span> : null}
      {props.end ? <span style={{ marginLeft: "auto", display: "inline-flex" }}>{props.end}</span> : null}
    </div>
  );
}

/** A roll as Again sends it: its formula as asked, with the mode beside it, its label, creature and range. */
export function againInput(roll: DiceRoll): DiceRollInput | null {
  const formula = askedFormula(roll);
  if (formula === null) return null;
  const input: DiceRollInput = { formula };
  if (roll.mode) input.mode = roll.mode;
  if (roll.cancelled) input.cancelled = true;
  if (roll.label !== undefined) input.label = roll.label;
  if (roll.tokenId !== undefined) input.creature = { tokenId: roll.tokenId };
  else if (roll.characterId !== undefined) input.creature = { characterId: roll.characterId };
  if (roll.critOn !== undefined) input.critOn = roll.critOn;
  return input;
}

function Row(props: { row: RecentRow; names: LogNames; me: string; open: boolean; again(rolls: DiceRollInput[], to: "all" | "dm"): void }) {
  const { row, names } = props;
  const [all, setAll] = useState(props.open);
  // The sticky line's tap scrolls its row into view, which would otherwise stop with the row's head under that line, as RollOptions allows for too.
  const base: CSSProperties = { display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}`, scrollMarginTop: 48 };
  if (row.kind === "bare") {
    const who = memberName(names, row.by);
    return (
      <li data-roll-row={row.ids.join(" ")} style={{ ...base, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
        {row.count === 1 ? `${who} rolled in secret.` : `${who} rolled in secret ${row.count} times.`}
      </li>
    );
  }
  if (row.kind === "answer") {
    return (
      <li data-roll-row={row.ids.join(" ")} style={base}>
        <span style={{ fontSize: theme.font.body14, overflowWrap: "anywhere" }}>{describeEvent(row.line, names)}</span>
        {row.line.dice ? <DiceFaces result={row.line.dice} /> : null}
      </li>
    );
  }
  const member = names.members[row.by];
  const shown = all ? row.rolls : row.rolls.slice(0, FOLDED);
  const mine = row.by === props.me;
  const inputs = mine ? row.rolls.map(againInput) : [];
  const canAgain = mine && inputs.every((i): i is DiceRollInput => i !== null);
  const first = row.rolls[0];
  const single = row.rolls.length === 1;
  const who = (
    <span style={{ display: "inline-flex", gap: theme.space(2), fontSize: theme.font.small }}>
      <span style={{ fontWeight: theme.weight.strong, color: member?.color ?? theme.color.text }}>{memberName(names, row.by)}</span>
      {row.to === "dm" ? <span style={{ color: theme.color.textMuted }}>Secret</span> : null}
      {single ? null : <span style={{ color: theme.color.textMuted }}>{row.rolls.length} rolls</span>}
    </span>
  );
  const again =
    canAgain && first ? (
      <IconButton
        icon="redo"
        label={`Roll again: ${[askedFormula(first), first.label].filter(Boolean).join(" ")}${single ? "" : ` and ${row.rolls.length - 1} more`}`}
        title="Again"
        onClick={() => props.again(inputs as DiceRollInput[], row.to)}
      />
    ) : null;
  return (
    <li data-roll-row={row.ids.join(" ")} style={base}>
      {single ? null : who}
      {shown.map((roll, i) => (
        <RollLine key={i} roll={roll} row={row} names={names} lead={single ? who : undefined} end={i === shown.length - 1 ? again : undefined} />
      ))}
      {row.rolls.length > FOLDED && !all ? (
        <div>
          <Button size="sm" variant="quiet" onClick={() => setAll(true)}>
            Show all {row.rolls.length}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Recent rolls under the options. `open` names a line whose row starts unfolded, the one the sticky line opened. */
export function RecentRolls(props: { names: LogNames; me: string; open: string | null; again(rolls: DiceRollInput[], to: "all" | "dm"): void }) {
  const log = useRoomView((s) => s.view?.log ?? EMPTY_LOG);
  const ui = useRoomUi();
  const here = usePanelHere();
  const rows = useMemo(() => recentRolls(log), [log]);
  return (
    <section aria-labelledby="dice-recent" style={{ display: "grid", gap: theme.space(1) }}>
      <h3 id="dice-recent" style={{ margin: 0, fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted, textTransform: "uppercase", letterSpacing: theme.caps }}>
        Recent rolls
      </h3>
      {rows.length === 0 ? (
        <Empty>No rolls yet. Type a formula or tap a die.</Empty>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <Row key={`${row.key}:${props.open !== null && row.ids.includes(props.open)}`} row={row} names={props.names} me={props.me} open={props.open !== null && row.ids.includes(props.open)} again={props.again} />
          ))}
        </ol>
      )}
      <div>
        <Button size="sm" variant="quiet" onClick={() => ui.openPanel("log", here ? { from: here } : undefined)}>
          Older rolls are in the Log
        </Button>
      </div>
    </section>
  );
}
