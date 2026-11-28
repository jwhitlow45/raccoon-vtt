import { useEffect, useMemo } from "react";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { LimitedUse } from "#shared/dice/uses.ts";
import { healRevivesDead } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { avoidTrait, reachWords } from "#shared/rules/opportunity.ts";
import { useDelayed } from "../../components/Loading.tsx";
import { displayName } from "../../lib/scene.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { creatureBlock, creatureRolls } from "../dice/creature.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { entryName, playerOwnedEntry } from "../encounter/logic.ts";
import { reactionFor } from "../encounter/ReactionSection.tsx";
import type { ReactionTarget } from "../encounter/ready.ts";
import { hiddenModules } from "../modules/gate.ts";
import { useFeaturesHere } from "../modules/Gate.tsx";
import type { ModuleId } from "../modules/registry.ts";
import {
  actorOf,
  answersFor,
  characterIdOf,
  promptsOf,
  turnParticipants,
  turnSince,
  usesCount,
  usesRows,
  type DeathSavePrompt,
  type Participant,
  type RechargePromptState,
  type RegenerationPrompt,
} from "./logic.ts";
import { slotCount } from "../slots/logic.ts";
import { useTurnReach, type MoverOut, type TurnReach } from "./opportunity.ts";
import { combatLocalSlot, promptId, regenerationIn, turnId, useCreaturesUses, useDismissed } from "./state.ts";
import type { Labels } from "../../lib/labels.ts";
import { useLabels } from "../../state/labels.ts";

/*
 * The cards a turn start brings to this device's alerts column
 * (docs/design/design-v1-combat-controls.md 4), from state alone, so a reload, a
 * second DM device and a late join show the same cards with the same
 * results: each creature of the turn this viewer answers for, its
 * Regeneration, death save and recharge prompts, and the turn card with
 * its uses. A card this device dismissed stays away for this turn.
 * A creature with attacks gets the card too, which lists them above its
 * uses (QOL audit Q1), so a goblin with no uses to spend has one.
 */

/** The attacks a turn card lists (QOL audit Q1): a creature's named rolls with an attack bonus in Actions and Bonus Actions, in its block's order. */
export function cardAttacks(named: readonly NamedRoll[]): NamedRoll[] {
  return named.filter((r) => r.attack !== undefined && (r.section === "actions" || r.section === "bonusActions"));
}

export type PromptCard<P> = { id: string; participant: Participant; record: number; prompt: P };

/**
 * A row of a block's Opportunity Attacks (docs/design/design-v1-opportunity-attacks.md
 * 1): the creature whose reach the turn's walk left, by the name this
 * viewer reads, whether a player's device counted it at 5 ft, the trait
 * that grants it more Reactions, and its Reaction where this viewer may
 * mark it used, while it is free.
 */
export type ReachRowModel = { id: string; name: string; fiveFt: boolean; trait: string | null; mark: ReactionTarget | null };

/**
 * A block's Opportunity Attacks: its rows, a job still checking once the
 * wait has lasted the shared delay (reachByMover), a leg past the cap, the
 * mover unseen, a trait of its block that may avoid them, and what its live
 * region says of the rows new on this device ("Left Goblin 2's reach.").
 */
export type BlockReach = { rows: readonly ReachRowModel[]; checking: boolean; over: boolean; unseen: boolean; avoid: string | null; announce?: string };

export const NO_REACH: BlockReach = { rows: [], checking: false, over: false, unseen: false, avoid: null };

export type TurnCardModel = {
  id: string;
  /** Whose turn it is: the landing row's creature, or its row's name when only other creatures of the turn are this viewer's. */
  name: string;
  /** Each creature of the turn this viewer answers for: its uses, their count, how many attacks it lists (cardAttacks), and its Opportunity Attacks. */
  blocks: { participant: Participant; uses: readonly LimitedUse[] | null; count: number; attacks: number; reach: BlockReach }[];
  /** The names of every block's Opportunity Attack rows, for the folded row's words. */
  left: readonly string[];
  /** A block's walk is still checked, for the folded row's words when it says nothing else. */
  checking: boolean;
  count: number;
  /** The attacks of every block, for the folded row's words. */
  attacks: number;
  /**
   * The room seq the attacks' results count from (logic.ts turnSince).
   * Infinite when nothing in this view names the turn's start, so no
   * result shows rather than an earlier turn's with its chips.
   */
  since: number;
  /** The card's wait and failure, the uses' and the rolls table's joined, which keep its blocks (cardLoad). */
  loading: boolean;
  failed: boolean;
  /** The uses' own wait and failure, for their line (blockLoad). */
  usesLoad: Load;
  /** Whether the rolls table failed, which the attacks' own line says. */
  rollsFailed: boolean;
};

type Load = { loading: boolean; failed: boolean };

export type CombatAlerts = {
  regenerations: PromptCard<RegenerationPrompt>[];
  deathSaves: (PromptCard<DeathSavePrompt> & { waits: boolean })[];
  recharges: PromptCard<RechargePromptState>[];
  turn: TurnCardModel | null;
  revives: boolean;
};

const NONE: CombatAlerts = { regenerations: [], deathSaves: [], recharges: [], turn: null, revives: false };

type You = { role: "dm" | "player"; memberId: string };

export function useCombatAlerts(): CombatAlerts {
  const labels = useLabels();
  const view = useRoomView((s) => s.view);
  // The copy `view` is built on, read as the view is (GroupSave.tsx reads it so too).
  const confirmed = useRoomView((s) => s.confirmed as RoomState | null);
  const you = useRoomView((s) => s.you);
  const local = useDismissed();
  const here = useFeaturesHere();
  // With no role known the choices are Everything, which hides nothing.
  const hidden = hiddenModules(here.role ?? "dm", here.choices);
  const all = useMemo(() => (view ? turnParticipants(view, labels) : []), [view, labels]);
  // The DM also gets a player's character's death save card (4.1), so the DM reads every creature of the turn.
  const shown = useMemo(() => (view && you ? all.filter((p) => answersFor(view, you, p.target) || (you.role === "dm" && p.record?.life === "dying")) : []), [view, you, all]);
  const targets = useMemo(() => shown.map((p) => p.target), [shown]);
  const read = useCreaturesUses(targets);
  // The attacks need the SRD's rolls table as well as its blocks, which the uses alone never wait on.
  const rolls = useDiceView(targets);
  const attacks = useMemo(() => targets.map((t) => (rolls.dice ? (creatureRolls(rolls.dice, t)?.named ?? null) : null)), [targets, rolls.dice]);
  const turnReach = useTurnReach();
  // The turn's jobs run one queue, so one wait covers them: a check done within the shared delay never shows, nor a card that only it would bring.
  const waited = useDelayed(Object.values(turnReach.movers).some((m) => m.checking));
  const movers = useMemo(() => Object.keys(turnReach.movers).map((id): ActorTarget => ({ tokenId: id })), [turnReach.movers]);
  const moverDice = useDiceView(movers);
  const reach = useMemo(
    () => (view && you ? reachByMover(view, you, labels, turnReach, (id) => (moverDice.dice ? creatureBlock(moverDice.dice, { tokenId: id }) : null), confirmed, waited) : {}),
    [view, confirmed, you, labels, turnReach, moverDice.dice, waited],
  );
  useReachReturns(turnReach, view, you);
  if (!view || !you || (shown.length === 0 && Object.keys(reach).length === 0)) return NONE;
  return combatAlerts({
    labels,
    view,
    you,
    participants: shown,
    uses: read.uses,
    attacks: attacks.map((named) => (named ? cardAttacks(named).length : null)),
    ...cardLoad(read, rolls),
    dismissed: local.dismissed,
    hidden,
    reach,
  });
}

/**
 * Each mover's Opportunity Attacks as its block shows them, by the mover's
 * token: the rows of the turn's jobs (opportunity.ts), named as this viewer
 * reads them, with the Reaction used each row may mark. A job still
 * checking counts only once the wait has lasted the shared delay
 * (`waited`), so "Checking the walk…" shows then, and a card it alone
 * brings never flashes for a check that ends sooner.
 */
export function reachByMover(
  view: Pick<RoomState, "tokens" | "characters" | "encounter">,
  you: You,
  labels: Labels,
  reach: Pick<TurnReach, "movers" | "fresh">,
  blockOf: (moverId: string) => Parameters<typeof avoidTrait>[0] | null,
  /** The server's copy under `view`: a Reaction marked here and not yet taken there keeps its row's button, busy. */
  confirmed?: Pick<RoomState, "tokens" | "encounter"> | null,
  waited = true,
): Record<string, BlockReach> {
  const out: Record<string, BlockReach> = {};
  for (const [moverId, mover] of Object.entries(reach.movers)) {
    const block = moverBlock(view, confirmed ?? view, you, labels, moverId, { ...mover, checking: mover.checking && waited }, blockOf(moverId));
    if (!block) continue;
    const fresh = reach.fresh.rows.filter((r) => r.moverId === moverId).flatMap((r) => block.rows.filter((m) => m.id === r.left.id).map((m) => m.name));
    out[moverId] = fresh.length > 0 ? { ...block, announce: `${capitalized(reachWords(fresh, "left", false, 3))}.` } : block;
  }
  return out;
}

function moverBlock(
  view: Pick<RoomState, "tokens" | "characters" | "encounter">,
  confirmed: Pick<RoomState, "tokens" | "encounter">,
  you: You,
  labels: Labels,
  moverId: string,
  mover: MoverOut,
  block: Parameters<typeof avoidTrait>[0] | null,
): BlockReach | null {
  if (mover.rows.length === 0 && !mover.checking && !mover.over) return null;
  const rows = mover.rows.flatMap((row): ReachRowModel[] => {
    const token = view.tokens[row.left.id];
    if (!token) return [];
    const kept = confirmed.tokens[token.id] ?? token;
    const entry = confirmed.encounter?.entries.find((e) => e.tokenId === token.id);
    const used = kept.companion?.turn !== undefined && kept.companion.turn !== "own" ? kept.companion.reactionUsed === true : entry?.reactionUsed === true;
    const mark = used ? null : reactionFor(view, you, { tokenId: token.id });
    return [{ id: token.id, name: displayName(token, labels), fiveFt: you.role === "player" && !row.left.known, trait: row.left.extra ? `${displayName(token, labels)}: ${row.left.extra}` : null, mark }];
  });
  const actor = actorOf(view, { tokenId: moverId });
  const unseen = actor?.effects?.some((e) => e.key === "invisible" || e.key === "hidden") === true;
  return { rows, checking: mover.checking, over: mover.over, unseen, avoid: block ? avoidTrait(block) : null };
}

/**
 * A row this device had not shown this turn brings a dismissed turn card
 * back, folded where it folds (D-261128-060): its dismissal and its
 * unfolding on this device go. The jobs' shown set decides what is new, so
 * a reload brings back no old row.
 */
/** The turn card's dismissal and unfolding on this device without `id`'s, or null where neither holds it. */
export function returned(local: { dismissed: ReadonlySet<string>; shown: ReadonlySet<string> }, id: string): { dismissed: ReadonlySet<string>; shown: ReadonlySet<string> } | null {
  if (!local.dismissed.has(id) && !local.shown.has(id)) return null;
  return { dismissed: new Set([...local.dismissed].filter((d) => d !== id)), shown: new Set([...local.shown].filter((d) => d !== id)) };
}

function useReachReturns(reach: TurnReach, view: Pick<RoomState, "encounter" | "tokens" | "characters"> | null, you: You | null): void {
  const scope = useRoomScope();
  const seq = reach.fresh.seq;
  const encounter = view?.encounter;
  useEffect(() => {
    const creature = view ? activeTarget(view) : null;
    // A DM's rows of a player's creature are the DM's toast's, on no card of this device.
    if (seq === 0 || !encounter?.activeEntryId || !you || !view || !creature || !answersFor(view, you, creature)) return;
    const local = scope.get(combatLocalSlot);
    const back = returned(local.getState(), turnId(encounter.activeEntryId, encounter.round));
    if (back) local.setState(back);
    // Only a new row's publish brings it back, never a later change of the turn's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, scope]);
}

/**
 * The turn card's wait and failure: its uses' and the rolls table's, which its
 * attacks need as well, joined to keep the card. Each part's own goes with
 * them, so a line names the load that failed.
 */
export function cardLoad(uses: Load, rolls: Load): Load & { usesLoad: Load; rollsFailed: boolean } {
  return { loading: uses.loading || rolls.loading, failed: uses.failed || rolls.failed, usesLoad: { loading: uses.loading, failed: uses.failed }, rollsFailed: rolls.failed };
}

/**
 * What a block's lines say while its parts load. The uses' line says the uses'
 * own wait or failure. The attacks stay quiet only where that line covers them:
 * the uses failed, and its one reload loads both, or both still load. A failed
 * rolls table says so itself beside uses that still load.
 */
export function blockLoad(model: Pick<TurnCardModel, "usesLoad" | "rollsFailed">, usesKnown: boolean): { uses: Load; attacksQuiet: boolean } {
  const uses = model.usesLoad;
  return { uses, attacksQuiet: !usesKnown && (uses.failed || (uses.loading && !model.rollsFailed)) };
}

/** The cards of the turn now for this viewer, free of React for its tests. */
export function combatAlerts(input: {
  labels: Labels;
  view: Pick<RoomState, "tokens" | "characters" | "encounter" | "meta" | "log">;
  you: You;
  participants: readonly Participant[];
  uses: readonly (readonly LimitedUse[] | null)[];
  /** How many attacks each lists, null while its rolls load. Left out, none do. */
  attacks?: readonly (number | null)[];
  loading: boolean;
  failed: boolean;
  /** Left out, the uses' wait and failure are the card's, and the rolls table never failed. */
  usesLoad?: Load;
  rollsFailed?: boolean;
  dismissed: ReadonlySet<string>;
  /** The parts hidden on this device, whose uses neither count nor admit a card (docs/design/design-v1-features.md 3). Left out, none. */
  hidden?: ReadonlySet<ModuleId>;
  /** Each mover's Opportunity Attacks, by its token (reachByMover). Left out, none. */
  reach?: Readonly<Record<string, BlockReach>>;
}): CombatAlerts {
  const { view, you, dismissed } = input;
  const out: CombatAlerts = { regenerations: [], deathSaves: [], recharges: [], turn: null, revives: healRevivesDead(view.meta.settings) };
  const blocks: TurnCardModel["blocks"] = [];
  const placed = new Set<string>();
  input.participants.forEach((p, i) => {
    const uses = input.uses[i] ?? null;
    const actor = actorOf(view, p.target);
    const answers = answersFor(view, you, p.target);
    if (p.record && actor) {
      const record = p.record;
      const prompts = promptsOf({ record, actor: { life: actor.life, hp: actor.hp, uses: actor.uses }, regeneration: regenerationIn(uses), uses });
      const keep = (what: string, settled: { state: string } | undefined) => settled?.state !== "skipped" && !dismissed.has(promptId(p.holder, record.id, what));
      const card = <P extends { what: string }>(prompt: P) => ({ id: promptId(p.holder, record.id, prompt.what), participant: p, record: record.id, prompt });
      const regen = prompts.regeneration;
      if (answers && regen && keep(regen.what, regen.settled)) out.regenerations.push(card(regen));
      const death = prompts.deathSave;
      // A player's character's card reaches the DM too, but a creature the DM plays never reaches a player.
      if (death && (answers || (you.role === "dm" && playerOwnedEntry(view, p.target))) && keep(death.what, death.settled)) {
        const waits = regen !== null && regen.settled === undefined && !dismissed.has(promptId(p.holder, record.id, "regeneration"));
        out.deathSaves.push({ ...card(death), waits });
      }
      if (answers) for (const r of prompts.recharges) if (keep(r.what, r.settled)) out.recharges.push(card(r));
    }
    if (!answers) return;
    const rows = usesRows({ form: "card", uses, actor, ownTurn: true, record: p.record });
    const characterId = characterIdOf(view, p.target);
    const character = characterId !== undefined ? view.characters[characterId] : undefined;
    const count = usesCount(rows, character?.resources, slotCount(character?.classes), input.hidden);
    const skipped = rows.some((r) => r.kind === "skipped");
    const attacks = input.attacks?.[i] ?? 0;
    // A card whose attacks still load keeps its place, so it never goes and comes back as the rolls table lands. One whose table failed keeps it with the failure and its reload.
    const attacksUnknown = input.attacks !== undefined && input.attacks[i] === null && (input.loading || input.failed);
    const mover = moverOf(view, p.target);
    const reach = (mover !== null ? input.reach?.[mover] : undefined) ?? NO_REACH;
    if (mover !== null) placed.add(mover);
    // A creature whose walk left an enemy's reach gets the card for its rows alone, and one whose walk is still checked for "Checking the walk…" (docs/design/design-v1-opportunity-attacks.md 1).
    if (count > 0 || skipped || attacks > 0 || attacksUnknown || (uses === null && (input.loading || input.failed)) || reach.rows.length > 0 || reach.checking || reach.over) blocks.push({ participant: p, uses, count, attacks, reach });
  });
  // A controlled mount sharing the turn, with no record of its own, still gets a block for the rows its walk left, for whoever answers for the turn.
  const turnCreature = activeTarget(view);
  for (const [moverId, reach] of Object.entries(input.reach ?? {})) {
    if (placed.has(moverId) || (reach.rows.length === 0 && !reach.checking && !reach.over) || !turnCreature || !answersFor(view, you, turnCreature)) continue;
    const token = view.tokens[moverId];
    if (!token) continue;
    blocks.push({ participant: { target: { tokenId: moverId }, holder: `t:${moverId}`, name: entryName(view, { tokenId: moverId }, input.labels), record: null, landing: false }, uses: null, count: 0, attacks: 0, reach });
  }
  const encounter = view.encounter;
  if (blocks.length > 0 && encounter?.activeEntryId) {
    const id = turnId(encounter.activeEntryId, encounter.round);
    if (!dismissed.has(id)) {
      const landing = input.participants.find((p) => p.landing);
      const entry = encounter.entries.find((e) => e.id === encounter.activeEntryId);
      const name = landing?.name ?? (entry ? entryName(view, entry, input.labels) : "This");
      const since = turnSince(view, input.participants) ?? Number.POSITIVE_INFINITY;
      const left = blocks.flatMap((b) => b.reach.rows.map((r) => r.name));
      out.turn = { id, name, blocks, left, checking: blocks.some((b) => b.reach.checking), count: blocks.reduce((n, b) => n + b.count, 0), attacks: blocks.reduce((n, b) => n + b.attacks, 0), since, loading: input.loading, failed: input.failed, usesLoad: input.usesLoad ?? { loading: input.loading, failed: input.failed }, rollsFailed: input.rollsFailed ?? false };
    }
  }
  return out;
}

/** The token a block's creature walks as: its own, or its character's token on the scene, for the turn's jobs keyed by token. */
function moverOf(view: Pick<RoomState, "tokens">, target: ActorTarget): string | null {
  if ("tokenId" in target) return target.tokenId;
  for (const t of Object.values(view.tokens)) if ("ref" in t.actor && t.actor.ref === target.characterId) return t.id;
  return null;
}

/** The turn's own creature, whose answerer reads a shared mount's rows. */
function activeTarget(view: Pick<RoomState, "encounter">): ActorTarget | null {
  const encounter = view.encounter;
  const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!entry) return null;
  return entry.tokenId !== undefined ? { tokenId: entry.tokenId } : entry.characterId !== undefined ? { characterId: entry.characterId } : null;
}

function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
