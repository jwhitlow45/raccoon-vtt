import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import { d20Formula, type AdvantageSource } from "#shared/dice/formula.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type SkillKey } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ABILITY_ABBR as ABILITY_SHORT } from "#shared/rules/skills.ts";
import { SKILLS } from "#shared/rules/skills.ts";
import { loadedMonsters } from "#shared/srd/monsters.ts";
import { Group, sectionLabelLook } from "../../../components/Panel.tsx";
import { displayName } from "../../../lib/scene.ts";
import { useUnsavedInput } from "../../../lib/sheetSwipe.ts";
import { theme } from "../../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import type { RoomView } from "../../../state/types.ts";
import { useRoomStore, useRoomView, type RoomViewStore } from "../../../state/view.ts";
import { FieldRow, Note, NumberField } from "../../tokens/ui.tsx";
import { CARD_PICTURES, CreatureCard } from "../CreatureCard.tsx";
import { creatureLook } from "../creatureLook.ts";
import { creatureRolls, type DiceView } from "../creature.ts";
import { severalKey, useDiceFolds } from "../diceFolds.ts";
import { rollsOf } from "../logic.ts";
import { cutLabel, damageRolls, withExtra } from "../options.ts";
import { presetFor } from "../presets.ts";
import { useDicePanel, type PanelRoll } from "../useDicePanel.ts";
import { loadedSrdRolls, useDiceView } from "../useDiceView.ts";
import { useReceipt, useReceipts, type ReceiptState } from "../useReceipt.ts";
import { useRollBlocked } from "../useRollOption.ts";
import { attackResults } from "./outcome.ts";
import { ReplaceConfirm } from "./ReplaceConfirm.tsx";
import { useAutoInitiativeFor } from "../../encounter/AutoInitiative.tsx";
import { useStartGroupSave, type StartInput } from "./start.ts";
import type { GroupTest } from "./rows.ts";

/**
 * Several selected creatures (docs/design-v1-roll-options.md 4.4): a DC,
 * then one tap rolls a save or check for every monster and asks every
 * player's creature, opening the group save with its results coming in.
 * The attacks every selected block shares by name roll each with its own
 * bonus against an optional AC, and the hits' damage rolls in one line.
 *
 * Drawn as the Dice panel draws one creature (docs/design-v1-dice-pass.md
 * 5.3): a card with their pictures, "3 selected" and their names, holding
 * what acts on the whole selection, then Saves and checks, Skills and
 * Shared attacks as folding groups, each remembered for the device.
 */
export function GroupOptions(props: { tokenIds: readonly string[] }) {
  const view = useRoomView((s) => s.view);
  const panel = useDicePanel();
  const start = useStartGroupSave();
  const blocked = useRollBlocked();
  const { fold } = useDiceFolds();
  const [dc, setDc] = useState<number | null>(null);
  const [pending, setPending] = useState<StartInput | null>(null);
  const creatures = useMemo<ActorTarget[]>(() => props.tokenIds.map((tokenId) => ({ tokenId })), [props.tokenIds]);
  const { dice, loading } = useDiceView(creatures);
  const shared = useMemo(() => (dice ? sharedAttacksOf(dice, creatures) : []), [dice, creatures]);
  const slot = useScoped(sharedAttacksSlot);
  const attacks = slot.store;
  const attackState = useStore(attacks, (s) => s.byName);
  const room = useRoomStore();
  // Only a tap below sends the DC or an attack's AC, so a sheet's swipe springs back once one is typed (docs/design-v1-sheet-swipe.md 4.6). The page it starts takes the DC with it.
  // An attack's AC is read here rather than in its row, so folding Shared attacks keeps the sheet from a swipe that would lose it.
  useUnsavedInput(dc !== null || shared.some((s) => unsentAc(attackState[s.name])));
  // The attacks' state belongs to the view of several, which goes once fewer than two are selected. A phone's Dice sheet closed to pick on the map is not that, so the watch outlives this view.
  useEffect(() => {
    slot.stop ??= watchSelection(attacks, room, () => ({ monsters: loadedMonsters(), rolls: loadedSrdRolls() }));
  }, [slot, attacks, room]);
  const sharedNames = shared.map((s) => s.name).join("\n");
  useEffect(() => {
    // While a block loads, no attack is shared yet, which is not the attack stopping being shared.
    if (loading) return;
    attacks.setState((s) => keepShared(s, sharedNames === "" ? [] : sharedNames.split("\n")));
  }, [attacks, sharedNames, loading]);
  const tracker = useReceipts();
  useSyncExternalStore(tracker.subscribe, tracker.version, tracker.version);
  if (!view) return null;
  const tokens = props.tokenIds.flatMap((id) => {
    const token = view.tokens[id];
    return token ? [token] : [];
  });
  const names = tokens.map((t) => displayName(t));
  const n = names.length;
  const pictures = tokens.slice(0, CARD_PICTURES).flatMap((token) => creatureLook({ view, creature: { tokenId: token.id }, name: displayName(token) })?.picture ?? []);

  const go = (input: StartInput) => {
    if (!start(input)) setPending(input);
  };
  const quick = (test: GroupTest) => {
    const taken = panel.take(creatures);
    go({ source: { kind: "selection", tokenIds: [...props.tokenIds] }, test, dc, panel: "dice", rollNow: { sources: taken.sources, secret: taken.secret } });
  };
  const sharedSummary = shared.map((s) => attackSummary(s.name, attackState[s.name], (tag) => tracker.state(tag))).join(", ");

  return (
    // The card and its first group part as one creature's do (RollOptions.tsx CreatureOptions), and the groups follow each other with no gap.
    <section aria-label="Group rolls" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <CreatureCard pictures={pictures} name={`${n} selected`} line={names.join(", ")}>
        {blocked ? <Note tone="info">{blocked}</Note> : null}
        {pending ? (
          <ReplaceConfirm
            onDiscard={() => {
              if (start(pending, { replace: true })) setPending(null);
            }}
            onKeep={() => setPending(null)}
          />
        ) : null}
        <FieldRow label="DC">
          <NumberField label="DC for the group" value={dc ?? undefined} min={1} max={50} nullable placeholder="None" onCommit={setDc} width={88} />
        </FieldRow>
        <GroupInitiative tokenIds={props.tokenIds} blocked={blocked} />
        {/* Its rows follow the selection until the roll (5.1), so a creature selected or dropped after it opens counts. A quick tap below rolls the creatures it was tapped on. */}
        <Cell text="Set up a group save" name="Set up a group save" disabled={null} center onTap={() => go({ source: { kind: "selection", tokenIds: [...props.tokenIds], live: true }, test: { kind: "save", ability: "dex" }, dc, panel: "dice" })} />
      </CreatureCard>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <Group label="Saves and checks" {...fold(severalKey("saves"))} summary={dc !== null ? `DC ${dc}` : "No DC"}>
          <QuickGrid label="Saves" n={n} disabled={blocked} onTap={(a) => quick({ kind: "save", ability: a })} kind="save" />
          <QuickGrid label="Checks" n={n} disabled={blocked} onTap={(a) => quick({ kind: "check", ability: a })} kind="check" />
        </Group>
        <Group label="Skills" {...fold(severalKey("skills"))}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gridAutoRows: "1fr", gap: theme.space(1) }}>
            {SKILL_KEYS.map((s: SkillKey) => (
              <Cell key={s} text={SKILLS[s].name} name={`${SKILLS[s].name} for ${n}`} disabled={blocked} onTap={() => quick({ kind: "check", ability: SKILLS[s].ability, skill: s })} />
            ))}
          </div>
        </Group>
        {dice && shared.length > 0 ? (
          <Group label="Shared attacks" {...fold(severalKey("sharedAttacks"))} summary={sharedSummary}>
            {shared.map((s) => (
              <SharedAttack key={s.name} name={s.name} each={s.each} dice={dice} blocked={blocked} />
            ))}
          </Group>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One option for the whole selection, in the look of a creature's option
 * cells (RollOptions.tsx OptionCell): the control outline on the raised
 * fill, its words at the start. The card's actions take it too, so the
 * card's buttons and the groups' share one look (docs/design-v1-dice-pass.md 7.3).
 * Those span the card, so `center` sets their words in the middle, as a
 * row's filling option cells do (RollOptions.tsx OptionCell `fill`), and the
 * card's rows keep one left edge. The words drop what the label above says
 * once, "DEX" under "Saves for 3", and the name keeps them all, "DEX save
 * for 3" (docs/design-v1-dice-pass.md 5.3), so the words take one line at
 * every size and a voice user still says the whole name.
 */
function Cell(props: { text: string; name: string; disabled: string | null; busy?: boolean; center?: boolean; onTap(): void }) {
  const off = props.disabled !== null;
  return (
    <button
      type="button"
      aria-label={props.name}
      aria-busy={props.busy ? true : undefined}
      disabled={off}
      title={props.disabled ?? undefined}
      onClick={() => {
        if (!props.busy) props.onTap();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: props.center ? "center" : "flex-start",
        minHeight: theme.touch,
        minWidth: 0,
        padding: `0 ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
        background: theme.color.surfaceRaised,
        color: off ? theme.color.textDisabled : theme.color.text,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        textAlign: props.center ? "center" : "left",
        overflowWrap: "anywhere",
        cursor: off || props.busy ? "default" : "pointer",
      }}
    >
      {props.busy ? `${props.text}…` : props.text}
    </button>
  );
}

/** A capitals label inside a group, an h4 under the group's h3 (6.6), in the panel's one label look. */
function GridLabel(props: { id: string; children: ReactNode }) {
  return (
    <h4 id={props.id} data-section-label="" style={{ margin: 0, paddingBottom: theme.space(1), ...sectionLabelLook() }}>
      {props.children}
    </h4>
  );
}

function QuickGrid(props: { label: string; n: number; kind: "save" | "check"; disabled: string | null; onTap(a: AbilityKey): void }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} style={{ display: "grid" }}>
      <GridLabel id={id}>{`${props.label} for ${props.n}`}</GridLabel>
      {/* Rows of one height, as a creature's grids (RollOptions.tsx Grid). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gridAutoRows: "1fr", gap: theme.space(1) }}>
        {ABILITY_KEYS.map((a) => (
          <Cell key={a} text={ABILITY_SHORT[a]} name={`${ABILITY_SHORT[a]} ${props.kind} for ${props.n}`} disabled={props.disabled} onTap={() => props.onTap(a)} />
        ))}
      </div>
    </div>
  );
}

type Attacker = { creature: ActorTarget; named: NamedRoll };

/** An attack every selected block has by name, with each creature's own roll of it. */
export type SharedAttackRow = { name: string; each: Attacker[] };

/**
 * The attacks every selected block has by name (4.4), in the first
 * creature's order. Each keeps its own bonus and critical range.
 */
export function sharedAttacksOf(dice: DiceView, creatures: readonly ActorTarget[]): SharedAttackRow[] {
  const lists = creatures.map((c) => ({ c, named: creatureRolls(dice, c)?.named.filter((r) => r.attack !== undefined) ?? [] }));
  const first = lists[0];
  if (!first) return [];
  return first.named
    .filter((r) => lists.every((l) => l.named.some((x) => x.name === r.name)))
    .map((r) => ({ name: r.name, each: lists.map((l) => ({ creature: l.c, named: l.named.find((x) => x.name === r.name)! })) }));
}

/**
 * A shared attack's state, kept out of its row so a fold that unmounts the
 * row keeps it (docs/design-v1-dice-pass.md 5.3 and 6.6): the AC typed, the
 * AC as the last attack sent it, the attackers and AC as sent, so the
 * results and their damage stay theirs when the selection changes after
 * the tap, and the damage roll's tag.
 */
export type SharedAttackState = {
  ac: number | null;
  acSent: number | null;
  sent: { tag: string; each: Attacker[]; ac: number | null } | null;
  damageTag: string | null;
};

export type SharedAttacks = { byName: Readonly<Record<string, SharedAttackState>> };

export const NO_ATTACK: SharedAttackState = { ac: null, acSent: null, sent: null, damageTag: null };

/**
 * Keyed by the attack's name within the view of several, never by the
 * selection, so an attack that stays shared as the selection changes keeps
 * what it sent. Per Room page, as every option the panel keeps. `stop`
 * ends the watch on the selection (watchSelection), once one is running.
 */
export const sharedAttacksSlot = scopeSlot(
  (): { store: StoreApi<SharedAttacks>; stop: (() => void) | null } => ({ store: createStore<SharedAttacks>(() => ({ byName: {} })), stop: null }),
  (slot) => {
    slot.stop?.();
    // React's development double mount keeps using the Room after disposing it, and the next view of several watches again.
    slot.stop = null;
  },
);

function useSharedAttacksStore() {
  return useScoped(sharedAttacksSlot).store;
}

/**
 * Watches the selection for the attacks' state, whether the view of
 * several is drawn then or not (docs/design-v1-dice-pass.md 5.3): fewer
 * than two selected clears every attack, so a selection that goes to one
 * and back never shows the old hits, and a selection that no longer shares
 * an attack drops that one, so a phone's Dice sheet closed while the DM
 * selects others never brings back hits a selection in between lost.
 * A selected creature whose block has yet to load drops nothing, since it
 * may share what it holds, and the view's own check settles it once drawn.
 * `srd` is the SRD as loaded so far. Hands back the end of the watch.
 */
export function watchSelection(attacks: StoreApi<SharedAttacks>, room: Pick<RoomViewStore, "subscribe">, srd: () => DiceView["srd"]): () => void {
  let seen: readonly string[] | null = null;
  return room.subscribe((s) => {
    const ids = s.local.selectedIds;
    if (ids === seen) return;
    seen = ids;
    if (Object.keys(attacks.getState().byName).length === 0) return;
    if (ids.length < 2) {
      attacks.setState({ byName: {} });
      return;
    }
    const gone = unshared(s, ids, Object.keys(attacks.getState().byName), srd());
    if (gone.length > 0) attacks.setState((a) => keepShared(a, Object.keys(a.byName).filter((name) => !gone.includes(name))));
  });
}

/** Of these kept attacks, the ones some selected creature whose block has loaded lacks by name, so they are no longer shared whatever the rest hold. */
function unshared(s: Pick<RoomView, "view" | "you">, ids: readonly string[], names: readonly string[], srd: DiceView["srd"]): string[] {
  if (!s.view || !s.you) return [];
  const dice: DiceView = { you: s.you, view: s.view, srd };
  const loaded = ids.flatMap((tokenId) => creatureRolls(dice, { tokenId }) ?? []);
  return names.filter((name) => loaded.some((rolls) => !rolls.named.some((r) => r.attack !== undefined && r.name === name)));
}

/** One attack's state changed, the others as they were. */
export function patchShared(s: SharedAttacks, name: string, patch: Partial<SharedAttackState>): SharedAttacks {
  return { byName: { ...s.byName, [name]: { ...(s.byName[name] ?? NO_ATTACK), ...patch } } };
}

/** Only the attacks still shared keep their state. The same object when none goes, so a store with nothing to drop tells no one. */
export function keepShared(s: SharedAttacks, names: readonly string[]): SharedAttacks {
  const gone = Object.keys(s.byName).filter((name) => !names.includes(name));
  if (gone.length === 0) return s;
  return { byName: Object.fromEntries(Object.entries(s.byName).filter(([name]) => names.includes(name))) };
}

/** An AC typed since the last attack, which only a tap sends. */
export function unsentAc(state: SharedAttackState | undefined): boolean {
  return state !== undefined && state.ac !== state.acSent;
}

/** The hits among an attack's results as they landed, judged by the AC it was sent with, else the AC typed now. */
function hitsOf(state: SharedAttackState, receipt: ReceiptState | null) {
  const sent = state.sent;
  const results = sent && receipt?.state === "committed" ? attackResults(sent.each, rollsOf(receipt.lines), sent.ac ?? state.ac) : [];
  return { results, hits: results.filter((r) => r.verdict === "hit" || r.verdict === "critical") };
}

/** An attack in the folded group's summary: its name, and the hits that wait for their damage, "Scimitar: 2 hits". */
export function attackSummary(name: string, state: SharedAttackState | undefined, receipt: (tag: string) => ReceiptState | null): string {
  if (!state?.sent || state.damageTag !== null) return name;
  const { hits } = hitsOf(state, receipt(state.sent.tag));
  return hits.length > 0 ? `${name}: ${hits.length} hit${hits.length === 1 ? "" : "s"}` : name;
}

/**
 * One shared attack (4.4) against an optional AC sent as the roll's AC,
 * never as a DC. "Roll damage for 4 hits" rolls each hit's damage, a
 * critical's by the room's rule, in one line, which an HP entry offers as
 * one chip: one target takes the hits, so there is no Apply.
 */
function SharedAttack(props: { name: string; each: Attacker[]; dice: DiceView; blocked: string | null }) {
  const panel = useDicePanel();
  const store = useSharedAttacksStore();
  const state = useStore(store, (s) => s.byName[props.name] ?? NO_ATTACK);
  const set = (patch: Partial<SharedAttackState>) => store.setState((s) => patchShared(s, props.name, patch));
  const receipt = useReceipt(state.sent?.tag ?? null);
  const damage = useReceipt(state.damageTag);
  const { results, hits } = hitsOf(state, receipt);
  const n = props.each.length;
  const attack = () => {
    const rolls: PanelRoll[] = props.each.map(({ creature, named }) => {
      const preset = presetFor(props.dice, creature, { kind: "attack" });
      return { formula: withExtra(d20Formula(named.attack ?? 0), preset.extra), label: cutLabel(named.name), creature, sources: [...preset.sources] as AdvantageSource[], ...(named.critOn ? { critOn: named.critOn } : {}) };
    });
    const ac = state.ac;
    set({ damageTag: null });
    const tag = panel.roll(rolls, ac !== null ? { ac } : {});
    // The attack sends the AC, and the field stays to read the hits, so the AC counts from the last attack on (docs/design-v1-sheet-swipe.md 4.6).
    set({ sent: tag ? { tag, each: [...props.each], ac } : null, acSent: ac });
  };
  const rollDamage = () => {
    const label = `${props.name} damage for ${hits.length} hits`;
    const rolls = hits.flatMap(({ each, verdict }) =>
      damageRolls({ ...each.named, name: label }, { on: new Set(), critical: verdict === "critical", creature: each.creature }).map((r) => ({ ...r, label: cutLabel(`${label}${r.label?.includes(",") ? `,${r.label.split(",").at(-1)}` : ""}`) })),
    );
    set({ damageTag: panel.roll(rolls) });
  };
  const total = damage?.state === "committed" ? rollsOf(damage.lines).reduce((a, r) => a + r.total, 0) : null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), borderTop: `${theme.line.border}px solid ${theme.color.border}`, paddingTop: theme.space(1) }}>
      <div style={{ display: "flex", gap: theme.space(2), alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto", display: "grid" }}>
          <Cell text={`${props.name} for ${n}`} name={`${props.name} for ${n}`} disabled={props.blocked} busy={receipt?.state === "sending"} onTap={attack} />
        </div>
        <NumberField label="Target's AC" value={state.ac ?? undefined} min={1} max={50} nullable placeholder="AC" onCommit={(ac) => set({ ac })} width={72} />
      </div>
      {results.length > 0 ? (
        <Note>{results.map((r) => `${r.roll.total}${r.verdict === "critical" ? " Critical Hit" : r.verdict === "hit" ? " hit" : r.verdict === "miss" ? " miss" : ""}`).join(", ")}</Note>
      ) : null}
      {hits.length > 0 ? (
        <Cell text={`Roll damage for ${hits.length} hit${hits.length === 1 ? "" : "s"}`} name={`Roll damage for ${hits.length} hit${hits.length === 1 ? "" : "s"}`} disabled={props.blocked} busy={damage?.state === "sending"} onTap={rollDamage} />
      ) : null}
      {total !== null ? <Note>{`${total} damage. Every HP entry offers it as a chip.`}</Note> : null}
    </div>
  );
}

/** "Initiative for the 4 in the fight" (4.4), by the tracker's auto initiative mode (section 7). Shown only for monsters in the fight. */
function GroupInitiative(props: { tokenIds: readonly string[]; blocked: string | null }) {
  const auto = useAutoInitiativeFor(props.tokenIds);
  if (auto.count === 0) return null;
  const words = `Initiative for the ${auto.count} in the fight`;
  return <Cell text={words} name={words} busy={auto.busy} disabled={props.blocked} center onTap={auto.press} />;
}
