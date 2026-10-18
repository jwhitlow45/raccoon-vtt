import { useMemo, useState } from "react";
import type { D20Test } from "#shared/dice/bonus.ts";
import { FORMULA_ERRORS } from "#shared/dice/formula.ts";
import type { InitEntry } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { groupKeyFor, rowGroup } from "#shared/rules/initiative.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import { presetFor } from "../dice/presets.ts";
import { NEEDS_CONNECTION } from "../dice/send.ts";
import { useDicePanel } from "../dice/useDicePanel.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useReceipt } from "../dice/useReceipt.ts";
import { describeRoll, initiativeRolls, MAY_HAVE_HAPPENED, noBonusSet, planPress, rollRows, rowsToRoll, type RollMode, type RollRow } from "./autoRoll.ts";
import { useAuto, useRollBusy, useShownRoll } from "./autoState.ts";
import { useRowFacts, useSendAll, useSortedEntries } from "./hooks.ts";
import { entryActor, entryName } from "./logic.ts";
import { RollBadge } from "./parts.tsx";

/**
 * The DM's auto initiative (features section 10, design 9.4): the controls
 * in the tracker, the card that shows what was rolled, and the per-row
 * tools in a row's options. Players never get any of it. The dice roll on
 * the server behind the screen, and the totals reach players as typed
 * values would (autoRoll.ts). The state behind it is in autoState.ts.
 */

const INITIATIVE: D20Test = { kind: "initiative" };
// Initiative reads only a creature's effects and the tracker's mark, never its block, so no SRD chunk is loaded for it.
const NO_CREATURES: ActorTarget[] = [];

/** The monster rows auto initiative can roll, from the DM's view, each with the initiative preset every d20 path reads. */
function useRollRows(entries: readonly InitEntry[]) {
  const { dice } = useDiceView(NO_CREATURES);
  return useMemo(() => {
    if (!dice) return { rows: [], skipped: [] };
    // Magic Resistance bears only on saves against spells, so initiative never waits for the block that says whether a creature has it.
    return rollRows(dice.view, entries, (e) => entryName(dice.view, e), (creature) => presetFor(dice, creature, INITIATIVE, { rolls: null }));
  }, [dice, entries]);
}

/**
 * One press: the shared rolls go to the server as one secret roll, and the
 * press is kept with what each roll is for until its lines land, when
 * autoState.ts sets the totals. With nothing to roll, every monster joined
 * its group's value, and the totals go at once.
 */
function usePress(): (rows: readonly RollRow[], mode: RollMode, kept?: readonly RollRow[]) => void {
  const { store } = useAuto();
  const panel = useDicePanel();
  const room = useRoomStore();
  return (rows, mode, kept = []) => {
    const plan = planPress(rows, mode, kept);
    const base = { mode, ...plan, tag: null, rolled: null, error: null, changed: [], done: false, sent: [] };
    if (plan.groups.length === 0) {
      store.setState({ last: base });
      return;
    }
    const connected = room.getState().connection === "open";
    const tag = connected ? panel.roll(initiativeRolls(plan.groups), { to: "dm" }) : null;
    // Connected, only the splitter refuses a group, when it is too big to roll at once.
    if (tag === null) store.setState({ last: { ...base, error: connected ? FORMULA_ERRORS.tooMuch : NEEDS_CONNECTION, done: true } });
    else store.setState({ last: { ...base, tag } });
  };
}

/**
 * The Dice panel's "Initiative for the 4 in the fight" for several selected
 * creatures (docs/design-v1-roll-options.md 4.4): their monster rows, rolled
 * by the tracker's mode as Auto initiative rolls them, their values
 * replaced.
 */
export function useAutoInitiativeFor(tokenIds: readonly string[]): { count: number; busy: boolean; press(): void } {
  const { mode } = useAuto();
  const sorted = useSortedEntries();
  const key = tokenIds.join(",");
  const entries = useMemo(() => sorted.filter((e) => e.tokenId !== undefined && tokenIds.includes(e.tokenId)), [sorted, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const { rows } = useRollRows(entries);
  const busy = useRollBusy();
  const press = usePress();
  return { count: rows.length, busy, press: () => !busy && rows.length > 0 && press(rows, mode, []) };
}

const MODES: { mode: RollMode; label: string; hint: string }[] = [
  {
    mode: "creature",
    label: "By creature",
    hint: "Identical monsters share one roll, and one added later takes their value. Every other monster rolls its own. Ungroup them in a row's options.",
  },
  { mode: "each", label: "One each", hint: "Every monster rolls its own." },
  { mode: "all", label: "All at once", hint: "One roll for every monster, so they all act together." },
];

/** The controls in the tracker's "Auto initiative" section. */
export function AutoInitiativeControls() {
  const { mode, setMode } = useAuto();
  const { rows, skipped } = useRollRows(useSortedEntries());
  const [reroll, setReroll] = useState(false);
  // Only Auto initiative reads the choice, so a sheet's swipe springs back once it is on. A roll leaves it on screen, and it counts from there (docs/design-v1-sheet-swipe.md 4.5).
  const restart = useUnsavedSince(reroll);
  const scores = useRoomView((s) => s.view?.meta.settings.monsterInitScore ?? false);
  const online = useRoomView((s) => s.connection === "open");
  const waiting = useRollBusy();
  const press = usePress();
  const toRoll = rowsToRoll(rows, reroll);
  const elsewhere = skipped.filter((s) => s.reason === "elsewhere").length;
  const chosen = MODES.find((m) => m.mode === mode) ?? MODES[0]!;

  return (
    <>
      <Segmented label="How monsters share rolls" value={mode} options={MODES.map((m) => ({ value: m.mode, label: m.label }))} onChange={setMode} />
      <Help>{chosen.hint}</Help>
      {/* A checkbox, not a switch: it changes nothing until Auto initiative reads it (docs/design-v1-visual.md 3.7). */}
      <Checkbox
        label="Re-roll monsters that have a value"
        help="Off rolls only monsters still waiting for one, such as a monster added mid-fight."
        checked={reroll}
        onChange={setReroll}
      />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        {/* Secondary: the tracker's one primary is Next (docs/design-v1-visual.md 3.3). */}
        <Button
          size="sm"
          busy={waiting}
          disabled={!waiting && (toRoll.length === 0 || !online)}
          onClick={() => {
            if (waiting || !online) return;
            // Without re-roll, monsters with a value keep it, and a waiting one may join its group's.
            press(toRoll, mode, reroll ? [] : rows.filter((r) => r.value !== null));
            restart();
          }}
        >
          {waiting ? "Rolling…" : `Auto initiative (${toRoll.length})`}
        </Button>
      </div>
      {!online && !waiting && toRoll.length > 0 ? <Help>{NEEDS_CONNECTION}</Help> : null}
      {toRoll.length === 0 && !waiting ? (
        <Help>
          {rows.length === 0
            ? "No monsters here to roll for."
            : scores
              ? "Every monster has a value: this room gives monsters their initiative scores. Turn on re-roll to roll instead."
              : "Every monster has a value. Turn on re-roll to roll them again."}
        </Help>
      ) : null}
      {elsewhere > 0 ? (
        <Help>
          {elsewhere === 1 ? "1 creature is" : `${elsewhere} creatures are`} on another scene and left out. View that scene to roll any monsters
          there.
        </Help>
      ) : null}
    </>
  );
}

const MODE_LABEL: Record<RollMode, string> = { creature: "by creature", each: "one each", all: "all at once" };

/**
 * What the last roll rolled, for the DM only: each shared roll's dice,
 * modifier and total, and who took it. It sits under the Auto initiative
 * button, where the DM just pressed, so the order starts right under the
 * round header (docs/design-v1-combat-flow.md 3.2). It stays until
 * dismissed, and goes when it no longer describes the fight: the fight
 * ended, another began, or an undo took the roll back (useShownRoll).
 */
export function AutoInitiativeResult() {
  const { store, roll: last } = useShownRoll();
  // Watched from the tap, so a result this card shows is never told again in a toast.
  useReceipt(last?.tag ?? null);
  // While the dice are on their way, the button shows it.
  if (!last || !last.done) return null;
  const dismiss = (
    <Button size="sm" onClick={() => store.setState({ last: null })}>
      Dismiss
    </Button>
  );
  if (last.rolled === null) {
    return (
      <section aria-label="Auto initiative results" style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <div role="status" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: last.error === MAY_HAVE_HAPPENED ? theme.color.warning : theme.color.dangerText }}>
            {last.error}
          </div>
          {dismiss}
        </div>
      </section>
    );
  }
  // Highest first, as the order above lists them. A joined line has no dice of its own.
  const lines = [
    ...last.rolled.map((group) => ({ rows: group.rows, total: group.total, group })),
    ...last.joined.map((joined) => ({ rows: joined.rows, total: joined.total, group: null })),
  ].sort((a, b) => b.total - a.total);
  const count = lines.reduce((n, line) => n + line.rows.length, 0);
  const changed = new Set(last.changed);
  const kept = lines.flatMap((line) => line.rows.filter((r) => changed.has(r.entryId)).map((r) => r.name));
  const note = { color: theme.color.textMuted, fontSize: theme.font.small } as const;
  return (
    <section aria-label="Auto initiative results" style={CARD}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>
            {count === 1 ? `Rolled ${lines[0]?.rows[0]?.name ?? "1 monster"}` : `Rolled ${count} monsters, ${MODE_LABEL[last.mode]}`}
          </div>
          <Help>Players see each visible monster's total, as if you typed it, never the dice or modifiers.</Help>
        </div>
        {dismiss}
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
        {lines.map(({ rows, total, group }, i) => (
          <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: theme.space(2) }}>
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
              <span style={{ fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>{rows.map((r) => r.name).join(", ")}</span>
              {group ? (
                <span style={{ ...note, display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), fontVariantNumeric: "tabular-nums" }}>
                  {group.roll.mode ? <RollBadge kind={group.roll.mode} /> : null}
                  {describeRoll(group.roll)}
                </span>
              ) : (
                <span style={note}>{rows.length === 1 ? "Takes its group's initiative" : "Take their group's initiative"}, as identical monsters do.</span>
              )}
              {group?.mixedModifier ? <span style={note}>Their modifiers differ: it adds the one most of them have.</span> : null}
              {group?.mixedExtra ? <span style={note}>Their penalties differ: it adds the one most of them have.</span> : null}
              {group?.mixedAdvantage ? <span style={note}>Their Advantage reminders differ, so one plain d20 was rolled.</span> : null}
              {group?.roll.cancelled && !group.mixedAdvantage ? <span style={note}>Advantage and Disadvantage cancel, so one plain d20 was rolled.</span> : null}
            </span>
            <span aria-label={`Total ${total}`} style={{ flex: "none", minWidth: 36, textAlign: "right", fontSize: theme.font.title, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>
              {total}
            </span>
          </li>
        ))}
      </ul>
      {kept.length > 0 ? (
        <Help>
          Not set for {kept.join(", ")}: {kept.length === 1 ? "its value" : "their values"} changed after you pressed.
        </Help>
      ) : null}
    </section>
  );
}

const CARD = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: theme.space(2),
  padding: theme.space(3),
  borderRadius: theme.radius.md,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
} as const;

/**
 * A monster row's own auto initiative tools, in its options: roll just this
 * one (for a monster added mid-fight, or a re-roll), and D&D Beyond's
 * Ungroup, which gives every monster of a group its own roll. Grouping
 * lives in the rows' group keys, which players never receive (design 7.3),
 * so it syncs to the DM's other devices and undoes like any other edit.
 */
export function RowRollTools(props: { entry: InitEntry }) {
  const { entry } = props;
  const facts = useRowFacts();
  const entries = useSortedEntries();
  const busy = useRollBusy();
  const online = useRoomView((s) => s.connection === "open");
  const press = usePress();
  const regroup = useSendAll();
  const row = useRollRows(useMemo(() => [entry], [entry])).rows[0];
  if (!row) return null;

  const ownKey = groupKeyFor(facts.view, entry);
  // Rows compare by `rowGroup`, so a row keyed before the dragon turtle's SRD id was renamed is in the same group.
  const grouped = entry.groupKey !== undefined ? entries.filter((e) => rowGroup(e) === rowGroup(entry)) : [];
  const joinable =
    entry.groupKey === undefined && ownKey !== undefined
      ? entries.filter((e) => rowGroup(e) === ownKey || (e.groupKey === undefined && groupKeyFor(facts.view, e) === ownKey))
      : [];

  const small = { flex: 1, minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted } as const;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
        <span style={small}>
          Initiative modifier {row.modifier < 0 ? `−${-row.modifier}` : `+${row.modifier}`}
          {noBonusSet(entryActor(facts.view, entry)) ? " (no initiative bonus set)" : ""}
        </span>
        <Button size="sm" busy={busy} disabled={!busy && !online} onClick={() => !busy && online && press([row], "each")}>
          {busy ? "Rolling…" : "Roll initiative"}
        </Button>
      </div>
      {!online && !busy ? <Help>{NEEDS_CONNECTION}</Help> : null}
      {grouped.length > 1 ? (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
          <span style={small}>
            Shares auto initiative with {grouped.length - 1} identical {grouped.length - 1 === 1 ? "monster" : "monsters"}
          </span>
          <Button
            size="sm"
            busy={regroup.waiting}
            onClick={() => !regroup.waiting && regroup.send(grouped.map((e) => ({ t: "encounter.update", entryId: e.id, patch: { groupKey: null } })))}
          >
            {regroup.waiting ? "Ungrouping…" : "Ungroup"}
          </Button>
        </div>
      ) : joinable.length > 1 && ownKey !== undefined ? (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
          <span style={small}>Rolls its own auto initiative</span>
          <Button
            size="sm"
            busy={regroup.waiting}
            onClick={() =>
              !regroup.waiting &&
              regroup.send(
                joinable.filter((e) => rowGroup(e) !== ownKey).map((e) => ({ t: "encounter.update", entryId: e.id, patch: { groupKey: ownKey } })),
              )
            }
          >
            {regroup.waiting ? "Grouping…" : `Group ${joinable.length} identical`}
          </Button>
        </div>
      ) : null}
    </>
  );
}
