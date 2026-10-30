import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { naturalOf, rolledTerms } from "#shared/dice/roll.ts";
import { creatureName, describeEvent, diceText, keptFrom, labelText, memberName, rolledFormula, type LogNames } from "#shared/logText.ts";
import type { DiceResult, DiceRoll, LogEntry } from "#shared/model.ts";
import type { DiceRollInput } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Group } from "../../components/Panel.tsx";
import { MarkedText, ProficiencyLabel } from "../../components/ProficiencyMark.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { usePanelHere } from "../panels.ts";
import { useDiceFolds } from "./diceFolds.ts";
import { againInput, askedRoll, recentRolls, rollVerdict, type RecentRow } from "./logic.ts";
import { eventMarks, ProficientEvent, type LevelOf } from "./ProficientEvent.tsx";
import { findMarks, marksTest, rollTarget, rollTest, type TextMark } from "./proficiencyPresentation.ts";
import type { ThrowOrigin } from "./throw/store.ts";
import { useThrows, useThrowView } from "./throw/useThrows.ts";
import { useProficiency } from "./useProficiency.ts";

/**
 * Recent rolls (docs/design-v1-dice.md 8.3): every roll in the viewer's
 * log, newest first, one row per roller and batch, with what each drew.
 * Its foot opens the Log, which holds the older ones. It folds as the
 * panel's other groups do, one fold for the device whoever the panel
 * rolls for (docs/design-v1-dice-pass.md 6.3).
 */

const EMPTY_LOG: LogEntry[] = [];
/** Rolls a row lists before "Show all". */
const FOLDED = 5;

/** The height of one line of a row's words: a die's chip, so a line of words alone stands as tall as one with dice. */
const LINE_PX = 24;
/**
 * Again's middle, where a row's first line of words stands, so a row of one
 * line is one touch target tall (docs/design-v1-dice-pass.md 7.6).
 */
const FIRST_LINE_TOP = (theme.touch - LINE_PX) / 2;

/**
 * What the folded group says (6.5): its newest row as one line, "Thorn 20
 * Longsword". A roll for a creature goes by the creature's name, which says
 * whose it was better than the roller's, and one with no label by its
 * formula. Null with no rolls yet, so a folded group says nothing.
 */
export function recentSummary(rows: readonly RecentRow[], names: LogNames, dm: boolean): string | null {
  const row = rows[0];
  if (!row) return null;
  if (row.kind === "bare") {
    const who = memberName(names, row.by);
    return row.count === 1 ? `${who} rolled in secret.` : `${who} rolled in secret ${row.count} times.`;
  }
  if (row.kind === "answer") return describeEvent(row.line, names, dm);
  const first = row.rolls[0];
  if (!first) return null;
  const who = first.tokenId !== undefined || first.characterId !== undefined ? creatureName(names, first) : memberName(names, row.by);
  const what = first.label !== undefined ? labelText(first.label) : rolledFormula(first);
  const more = row.rolls.length - 1;
  return `${who} ${first.total.toLocaleString("en-US")} ${what}${more > 0 ? ` and ${more} more` : ""}`;
}

/** recentSummary's words with the test they name marked: an answer's as the Log marks it, a creature's roll at its label. */
function recentSummaryMarks(rows: readonly RecentRow[], names: LogNames, dm: boolean, levelOf: LevelOf): { text: string; marks: TextMark[] } | null {
  const text = recentSummary(rows, names, dm);
  const row = rows[0];
  if (text === null || !row) return null;
  if (row.kind === "answer") return eventMarks(row.line, names, dm, levelOf);
  const first = row.kind === "dice" ? row.rolls[0] : undefined;
  const target = first ? rollTarget(first) : null;
  const test = first ? rollTest(first) : null;
  if (!first || !target || first.label === undefined || !marksTest(test)) return { text, marks: [] };
  // "Thorn 19 Perception check": the label follows the total.
  return { text, marks: findMarks(text, [{ label: labelText(first.label), level: levelOf(target, test), after: `${first.total.toLocaleString("en-US")} ` }], creatureName(names, first).length) };
}

/**
 * The faces of one roll as chips: a dropped die struck through, a natural
 * 20 or 1 marked. Text for a screen reader beside them.
 */
export function DiceFaces(props: { result: FacesOf }) {
  const chips = faceChips(props.result);
  if (!chips) return <span style={{ color: theme.color.textMuted }}>{props.result.formula}</span>;
  return (
    // The chips wrap in a box of their own rather than one with no box (display: contents), so the second line they take stands where the eye and the alignment sweep both find it.
    <span style={{ display: "inline-flex", minWidth: 0 }}>
      <span aria-hidden="true" style={{ display: "inline-flex", flexWrap: "wrap", gap: theme.space(1), alignItems: "center", minWidth: 0 }}>
        {chips}
      </span>
      <span style={visuallyHidden}>{diceText(props.result)}</span>
    </span>
  );
}

type FacesOf = Pick<DiceResult, "formula" | "faces" | "total" | "mode" | "crit">;

/** A roll's faces as chips, each marked `data-face`, or null for a roll with no dice drawn. */
export function faceChips(result: FacesOf): ReactNode[] | null {
  const terms = rolledTerms(result);
  const natural = naturalOf(result);
  if (!terms) return null;
  return terms.flatMap((t, ti) =>
    "kept" in t
      ? t.faces.map((face, i) => {
          const dropped = !t.kept[i];
          const nat = !dropped && t.term.sides === 20 && natural !== null && face === natural;
          const style: CSSProperties = {
            ...FACE_CHIP,
            border: `${theme.line.border}px solid ${nat ? (face === 20 ? theme.color.accent : theme.color.danger) : theme.color.border}`,
            color: dropped ? theme.color.textDisabled : theme.color.text,
            textDecoration: dropped ? "line-through" : undefined,
          };
          return (
            <span key={`${ti}:${i}`} data-face="" style={style}>
              {face.toLocaleString("en-US")}
            </span>
          );
        })
      : [],
  );
}

/** A die's chip, 24 px tall, and the header line's "+2" for the dice it drops (Roller.tsx). */
export const FACE_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  minWidth: 24,
  height: 24,
  padding: `0 ${theme.space(1)}px`,
  borderRadius: theme.radius.sm,
  fontSize: theme.font.small,
  fontWeight: theme.weight.strong,
  background: theme.color.surfaceRaised,
  fontVariantNumeric: "tabular-nums",
};

const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

/** A row with no Again keeps a touch target's height, its words in its middle while they take one line. */
const FLOOR: CSSProperties = { display: "grid", alignContent: "center", minHeight: theme.touch };

/** A quiet button's side padding and its border, which "Older rolls are in the Log" stands outside the column by, so its words start on the column's edge (7.6). */
const QUIET_INSET = theme.space(3) + theme.line.border;

/**
 * One roll of a row: its total, its creature and label, its dice and its
 * verdict. `lead` goes before them, a single roll's roller, and `end` after,
 * at the line's far end, the row's Again, so a row of one roll takes one or
 * two lines rather than three.
 */
function RollLine(props: { roll: DiceRoll; row: { dc?: number; ac?: number }; names: LogNames; levelOf: LevelOf; by?: string; lead?: ReactNode; end?: ReactNode; floor?: boolean }) {
  const { roll } = props;
  const creature = roll.tokenId !== undefined || roll.characterId !== undefined ? creatureName(props.names, roll) : null;
  // "Thorn 9 Thorn, Longsword damage" said the name twice where a player rolls for the character of the same name.
  const named = creature !== null && creature === props.by ? null : creature;
  const label = roll.label === undefined ? undefined : labelText(roll.label);
  const what = [named, label].filter(Boolean).join(", ");
  const target = rollTarget(roll);
  const test = rollTest(roll);
  const verdict = rollVerdict(roll, props.row);
  const formula = rolledFormula(roll);
  const again = props.end !== undefined && props.end !== null;
  const split = !again && props.floor === true;
  return (
    // Again holds the line's top right corner, so the words wrap beside it and it never takes a line of its own (docs/design-v1-dice-ui.md 4.5).
    // Beside Again the first line of words stands at its middle. A row of one roll with no Again splits that space above and below its words, so rows of the same lines share a height and keep their words in their middle.
    <div style={{ display: "flex", alignItems: "flex-start", gap: theme.space(2) }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          alignContent: again ? "flex-start" : "center",
          columnGap: theme.space(2),
          rowGap: theme.space(1),
          lineHeight: `${LINE_PX}px`,
          paddingTop: again ? FIRST_LINE_TOP : split ? FIRST_LINE_TOP / 2 : 0,
          paddingBottom: split ? FIRST_LINE_TOP / 2 : undefined,
          minHeight: again || split ? theme.touch : undefined,
        }}
      >
        <LastGrows>
          {props.lead}
          <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>{roll.total.toLocaleString("en-US")}</span>
          {what ? (
            <span style={{ fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
              {target && label && marksTest(test) ? (
                <>
                  {named ? `${named}, ` : ""}
                  <ProficiencyLabel level={props.levelOf(target, test)}>{label}</ProficiencyLabel>
                </>
              ) : (
                what
              )}
            </span>
          ) : null}
          {/* The formula and its dice wrap together, so a line never holds dice with no words, which would read as a label above them. */}
          <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1), minWidth: 0 }}>
            <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{formula}</span>
            <DiceFaces result={roll} />
          </span>
          {/* Only the DM's copy keeps the mark of an initiative roll kept from players (docs/design-v1-combat-flow.md 11.3). */}
          {roll.hidden ? (
            <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>
              Hidden from {keptFrom(roll, props.names)}
            </span>
          ) : null}
          {verdict ? (
            <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>
              {verdict}
            </span>
          ) : null}
        </LastGrows>
      </div>
      {props.end}
    </div>
  );
}

/**
 * A row's parts, the last of them in a box that grows to the end of its
 * line, so a part that wraps onto a line alone, such as "Natural 20" or the
 * dice, fills that line rather than standing alone under the others, as the
 * polish pass's wrap rule asks (docs/design-v1-polish.md 4). Its words stay
 * at the line's start.
 */
function LastGrows(props: { children: ReactNode[] }) {
  const parts = props.children.filter((part) => part !== null && part !== undefined && part !== false);
  const last = parts.length - 1;
  return (
    <>
      {parts.map((part, i) =>
        i === last ? (
          <span key={i} style={{ flex: "1 0 auto", display: "flex", alignItems: "center", minWidth: 0, maxWidth: "100%" }}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Row(props: { row: RecentRow; names: LogNames; levelOf: LevelOf; me: string; dm: boolean; open: boolean; again(rolls: DiceRollInput[], to: "all" | "dm", origin: ThrowOrigin): void }) {
  const { row, names } = props;
  const throws = useThrows();
  const [all, setAll] = useState(props.open);
  // The sticky line's tap brings its row into view clear of that line by the line's own height (DicePanel.tsx revealUnderLine).
  const base: CSSProperties = { display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` };
  if (row.kind === "bare") {
    const who = memberName(names, row.by);
    return (
      <li data-roll-row={row.ids.join(" ")} style={{ ...base, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
        <div style={FLOOR}>{row.count === 1 ? `${who} rolled in secret.` : `${who} rolled in secret ${row.count} times.`}</div>
      </li>
    );
  }
  if (row.kind === "answer") {
    return (
      <li data-roll-row={row.ids.join(" ")} style={base}>
        <div style={{ ...FLOOR, gap: theme.space(1) }}>
          <span style={{ fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
            <ProficientEvent data={row.line} names={names} dm={props.dm} levelOf={props.levelOf} />
          </span>
          {row.line.dice ? <DiceFaces result={row.line.dice} /> : null}
        </div>
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
        icon="again"
        label={`Roll again: ${[askedRoll(first)?.formula, first.label === undefined ? undefined : labelText(first.label)].filter(Boolean).join(" ")}${single ? "" : ` and ${row.rolls.length - 1} more`}`}
        title="Roll again"
        onClick={() => props.again(inputs as DiceRollInput[], row.to, throws.origin())}
      />
    ) : null;
  return (
    <li data-roll-row={row.ids.join(" ")} style={base}>
      {single ? null : who}
      {shown.map((roll, i) => (
        <RollLine key={i} roll={roll} row={row} names={names} levelOf={props.levelOf} by={memberName(names, row.by)} lead={single ? who : undefined} end={i === shown.length - 1 ? again : undefined} floor={single} />
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

/**
 * Recent rolls under the options. `open` names a line whose row starts
 * unfolded, the one the sticky line opened. A roll whose dice are in the
 * air joins the list as they land.
 */
export function RecentRolls(props: { names: LogNames; me: string; open: string | null; again(rolls: DiceRollInput[], to: "all" | "dm", origin: ThrowOrigin): void }) {
  const log = useRoomView((s) => s.view?.log ?? EMPTY_LOG);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const ui = useRoomUi();
  const here = usePanelHere();
  const { held } = useThrowView();
  const { fold } = useDiceFolds();
  const rows = useMemo(() => recentRolls(log, held), [log, held]);
  const levelOf = useProficiency();
  const summary = recentSummaryMarks(rows, props.names, dm, levelOf);
  return (
    // A group is no landmark (components/Panel.tsx), so the mark sits on a plain box around it.
    <div data-dice-recent="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <Group label="Recent rolls" {...fold("recent")} summary={summary ? <MarkedText text={summary.text} marks={summary.marks} /> : undefined}>
        {rows.length === 0 ? (
          <Empty>No rolls yet. Type a formula or tap a die.</Empty>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rows.map((row) => (
              <Row key={`${row.key}:${props.open !== null && row.ids.includes(props.open)}`} row={row} names={props.names} levelOf={levelOf} me={props.me} dm={dm} open={props.open !== null && row.ids.includes(props.open)} again={props.again} />
            ))}
          </ol>
        )}
        <div>
          <Button size="sm" variant="quiet" onClick={() => ui.openPanel("log", here ? { from: here } : undefined)} style={{ marginInlineStart: -QUIET_INSET }}>
            Older rolls are in the Log
          </Button>
        </div>
      </Group>
    </div>
  );
}
