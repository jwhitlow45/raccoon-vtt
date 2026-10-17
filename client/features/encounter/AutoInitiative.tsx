import { useMemo, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { InitEntry } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { groupKeyFor } from "#shared/rules/initiative.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { describeRoll, noBonusSet, rollOps, rollRows, rowsToRoll, type RollMode, type RollRow } from "./autoRoll.ts";
import { useAuto, useShownRoll, type AutoState } from "./autoState.ts";
import { useRowFacts, useSendAll, useSortedEntries } from "./hooks.ts";
import { entryActor, entryName } from "./logic.ts";
import { RollBadge } from "./parts.tsx";

/**
 * The DM's auto initiative (features section 10, design 9.4): the controls
 * in the tracker, the card that shows what was rolled, and the per-row
 * tools in a row's options. Players never get any of it, and the dice never
 * leave this device: the server receives the totals as typed values would
 * arrive (autoRoll.ts). The state behind it is in autoState.ts.
 */

/** The monster rows auto initiative can roll, from the DM's view. */
function useRollRows() {
  const entries = useSortedEntries();
  const facts = useRowFacts();
  return useMemo(() => rollRows(facts.view, entries, (e) => entryName(facts.view, e)), [facts.view, entries]);
}

/** Rolls on this device, sends what changed (rollOps), and keeps the dice for the card. */
function rollAndSend(
  rows: readonly RollRow[],
  mode: RollMode,
  send: (ops: readonly ClientOp[]) => readonly number[],
  store: StoreApi<AutoState>,
  kept: readonly RollRow[] = [],
): void {
  const { ops, result } = rollOps(rows, mode, undefined, kept);
  const sent = send(ops);
  store.setState({ last: { ...result, sent } });
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
  const { store, mode, setMode } = useAuto();
  const { rows, skipped } = useRollRows();
  const [reroll, setReroll] = useState(false);
  // Only Auto initiative reads the choice, so a sheet's swipe springs back once it is on. A roll leaves it on screen, and it counts from there (docs/design-v1-sheet-swipe.md 4.5).
  const restart = useUnsavedSince(reroll);
  const scores = useRoomView((s) => s.view?.meta.settings.monsterInitScore ?? false);
  const { send, waiting } = useSendAll();
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
          disabled={!waiting && toRoll.length === 0}
          onClick={() => {
            if (waiting) return;
            // Without re-roll, monsters with a value keep it, and a waiting one may join its group's.
            rollAndSend(toRoll, mode, send, store, reroll ? [] : rows.filter((r) => r.value !== null));
            restart();
          }}
        >
          {waiting ? "Rolling…" : `Auto initiative (${toRoll.length})`}
        </Button>
      </div>
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
  if (!last) return null;
  // Highest first, as the order above lists them. A joined line has no dice of its own.
  const lines = [
    ...last.groups.map((group) => ({ rows: group.rows, total: group.total, group })),
    ...last.joined.map((joined) => ({ rows: joined.rows, total: joined.total, group: null })),
  ].sort((a, b) => b.total - a.total);
  const count = lines.reduce((n, line) => n + line.rows.length, 0);
  return (
    <section
      aria-label="Auto initiative results"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.surfaceRaised,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>
            {count === 1 ? `Rolled ${lines[0]?.rows[0]?.name ?? "1 monster"}` : `Rolled ${count} monsters, ${MODE_LABEL[last.mode]}`}
          </div>
          <Help>Players see each visible monster's total, as if you typed it, never the dice or modifiers.</Help>
        </div>
        <Button size="sm" onClick={() => store.setState({ last: null })}>
          Dismiss
        </Button>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
        {lines.map(({ rows, total, group }, i) => (
          <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: theme.space(2) }}>
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
              <span style={{ fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>{rows.map((r) => r.name).join(", ")}</span>
              {group ? (
                <span
                  style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), color: theme.color.textMuted, fontSize: theme.font.small, fontVariantNumeric: "tabular-nums" }}
                >
                  {group.roll.advantage !== "normal" ? <RollBadge kind={group.roll.advantage} /> : null}
                  {describeRoll(group)}
                </span>
              ) : (
                <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
                  {rows.length === 1 ? "Takes its group's initiative" : "Take their group's initiative"}, as identical monsters do.
                </span>
              )}
              {group?.mixedModifier ? (
                <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>Their modifiers differ: it adds the one most of them have.</span>
              ) : null}
              {group?.mixedAdvantage ? (
                <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>Their advantage reminders differ, so one plain d20 was rolled.</span>
              ) : null}
            </span>
            <span aria-label={`Total ${total}`} style={{ flex: "none", minWidth: 36, textAlign: "right", fontSize: theme.font.title, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>
              {total}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A monster row's own auto initiative tools, in its options: roll just this
 * one (for a monster added mid-fight, or a re-roll), and D&D Beyond's
 * Ungroup, which gives every monster of a group its own roll. Grouping
 * lives in the rows' group keys, which players never receive (design 7.3),
 * so it syncs to the DM's other devices and undoes like any other edit.
 */
export function RowRollTools(props: { entry: InitEntry }) {
  const { entry } = props;
  const { store } = useAuto();
  const facts = useRowFacts();
  const entries = useSortedEntries();
  const roll = useSendAll();
  const regroup = useSendAll();
  const row = useMemo(() => rollRows(facts.view, [entry], (e) => entryName(facts.view, e)).rows[0], [facts.view, entry]);
  if (!row) return null;

  const ownKey = groupKeyFor(facts.view, entry);
  const grouped = entry.groupKey !== undefined ? entries.filter((e) => e.groupKey === entry.groupKey) : [];
  const joinable =
    entry.groupKey === undefined && ownKey !== undefined
      ? entries.filter((e) => e.groupKey === ownKey || (e.groupKey === undefined && groupKeyFor(facts.view, e) === ownKey))
      : [];

  const small = { flex: 1, minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted } as const;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
        <span style={small}>
          Initiative modifier {row.modifier < 0 ? `−${-row.modifier}` : `+${row.modifier}`}
          {noBonusSet(entryActor(facts.view, entry)) ? " (no initiative bonus set)" : ""}
        </span>
        <Button size="sm" busy={roll.waiting} onClick={() => !roll.waiting && rollAndSend([row], "each", roll.send, store)}>
          {roll.waiting ? "Rolling…" : "Roll initiative"}
        </Button>
      </div>
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
                joinable.filter((e) => e.groupKey !== ownKey).map((e) => ({ t: "encounter.update", entryId: e.id, patch: { groupKey: ownKey } })),
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
