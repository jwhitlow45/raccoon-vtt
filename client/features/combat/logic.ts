import type { DayUse, LegendaryUse, LimitedUse, RechargeUse, RegenerationUse, RestUse } from "#shared/dice/uses.ts";
import type { Actor, ClassResource, Encounter, PromptKey, RoomState, Settled, TurnRecord, UseKey, UseMark } from "#shared/model.ts";
import type { ProjectedActor } from "#shared/project.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { actsOnCharacterTurn } from "#shared/reducer/companions.ts";
import { damageTypeName, type DamageType } from "#shared/rules/damage.ts";
import { marksTime } from "../attach/tags.ts";
import { entryName, ownsEntry, playerOwnedEntry } from "../encounter/logic.ts";
import { rechargeRange } from "../encounter/saveCards.ts";

/*
 * The combat uses of a creature (docs/design-v1-combat-controls.md 4 to 6),
 * free of React so node --test covers them: whose turn record is current,
 * which prompts a record holds open, the rows of the one list the turn
 * card, the tracker row's Uses group and the token bar's Uses drawer share,
 * the ops their buttons send, and the words they show.
 */

type View = Pick<RoomState, "tokens" | "characters" | "encounter">;
type Turn = Pick<Encounter, "activeEntryId" | "round"> | null | undefined;

/** A creature's turn record while its row acts in its round, else null: an older record only ever says that turn is over (2.3). */
export function currentRecord(encounter: Turn, actor: Pick<Actor, "turnRecord"> | undefined): TurnRecord | null {
  const record = actor?.turnRecord;
  if (!record || !encounter || encounter.activeEntryId !== record.entryId || encounter.round !== record.round) return null;
  return record;
}

/**
 * The turn a display shows, as one id, or null with no turn: its row, its
 * round and the seq of the op that started it (`TurnStart.seq`), which
 * Previous puts back with the turn and Next after Previous makes anew. A
 * player's view may lack the seq, so there the row and round name it.
 */
export function turnKey(encounter: Pick<Encounter, "activeEntryId" | "round" | "turnStart"> | null | undefined): string | null {
  if (!encounter?.activeEntryId) return null;
  const start = encounter.turnStart;
  const seq = start?.entryId === encounter.activeEntryId ? start.seq : undefined;
  return `${encounter.activeEntryId}|${encounter.round}|${seq ?? ""}`;
}

/** A Roll recharge a uses list sent (combat/state.ts useListRolls): its tag, and the turn the list showed as it rolled (`turnKey`). */
export type ListRoll = { tag: string; turn: string | null };

/** A list roll's failure: its tag and the words its status line or a toast gives it. */
export type ListTrouble = { tag: string; text: string };

/**
 * What a uses list says of its own Roll recharge that did not land
 * (CardRoll.tsx rollTrouble, reviews CCB-ASTRA-02, CCB-ASTRA-06 and
 * CCB-OPUS-12). Its rows' rolls count while each is still its row's newest
 * (`newest`, the Dice panel's row may have rolled since). Among their
 * failures that a later tap did not silence, it shows the newest by tag,
 * uuidv7 and so in time order. A roll sent on a turn says so only while
 * that turn is current, and never again in a list opened after one showed
 * it. One sent with no turn says so only in a list that was open as it
 * failed, until that list's next tap. `passed` are the failures that came
 * once their turn had passed, which no list showed, for a toast, since a
 * list roll goes quiet and nothing else would tell them. `opened` is what
 * stood as the list opened: the failures shown before, and those already
 * in.
 */
export function listRollTrouble(input: {
  rows: readonly string[];
  rolls: Readonly<Record<string, ListRoll>>;
  newest: Readonly<Record<string, string>>;
  turn: string | null;
  trouble(tag: string): string | null;
  silenced: ReadonlySet<string>;
  seen: ReadonlySet<string>;
  opened: { seen: ReadonlySet<string>; failed: ReadonlySet<string> };
}): { shown: ListTrouble | null; passed: ListTrouble[] } {
  let shown: ListTrouble | null = null;
  const passed: ListTrouble[] = [];
  for (const row of input.rows) {
    const roll = input.rolls[row];
    if (!roll || input.newest[row] !== roll.tag) continue;
    const text = input.trouble(roll.tag);
    if (!text) continue;
    const { tag } = roll;
    if (roll.turn !== null && roll.turn !== input.turn) {
      if (!input.opened.failed.has(tag) && !input.seen.has(tag)) passed.push({ tag, text });
      continue;
    }
    if (input.silenced.has(tag) || input.opened.seen.has(tag) || (roll.turn === null && input.opened.failed.has(tag))) continue;
    if (!shown || tag > shown.tag) shown = { tag, text };
  }
  return { shown, passed };
}

/** The holder of a creature's uses as one id: its character for a token that plays one, as the reducer resolves it. */
export function holderKey(view: Pick<RoomState, "tokens">, target: ActorTarget): string {
  if ("characterId" in target) return `c:${target.characterId}`;
  const token = view.tokens[target.tokenId];
  return token && "ref" in token.actor ? `c:${token.actor.ref}` : `t:${target.tokenId}`;
}

/** The actor behind a target as this viewer holds it. */
export function actorOf(view: Pick<RoomState, "tokens" | "characters">, target: ActorTarget): ProjectedActor | undefined {
  if ("characterId" in target) return view.characters[target.characterId]?.actor as ProjectedActor | undefined;
  const token = view.tokens[target.tokenId];
  if (!token) return undefined;
  if ("inline" in token.actor) return token.actor.inline as ProjectedActor;
  return view.characters[token.actor.ref]?.actor as ProjectedActor | undefined;
}

/** The character behind a target, whose class resources it holds, or undefined for a creature of its own. */
export function characterIdOf(view: Pick<RoomState, "tokens">, target: ActorTarget): string | undefined {
  if ("characterId" in target) return target.characterId;
  const token = view.tokens[target.tokenId];
  return token && "ref" in token.actor ? token.actor.ref : undefined;
}

/**
 * Whether a creature acts now, when its legendary actions wait for another
 * creature's turn (5, 13.1): the acting row is its own, it is a companion
 * that acts on that row's character's turn, or a turn it shares with
 * another row's creature started for it, as a controlled mount's does with
 * its rider's (its current record). The tracker row, a companion's
 * sub-row and the token bar all ask this, so they never disagree.
 */
export function actsNow(view: View, target: ActorTarget): boolean {
  const encounter = view.encounter;
  const active = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!encounter || !active) return false;
  const acting = active.tokenId !== undefined ? holderKey(view, { tokenId: active.tokenId }) : active.characterId !== undefined ? `c:${active.characterId}` : null;
  if (acting !== null && acting === holderKey(view, target)) return true;
  const token = "tokenId" in target ? view.tokens[target.tokenId] : undefined;
  if (token?.companion && actsOnCharacterTurn(token) && acting === `c:${token.companion.of}`) return true;
  return currentRecord(encounter, actorOf(view, target)) !== null;
}

/** A creature of the turn now (2.3): the landing row's own, or another with a current record, by its holder. */
export type Participant = { target: ActorTarget; holder: string; name: string; record: TurnRecord | null; landing: boolean };

/**
 * The creatures of the turn now (2.3): the landing row's own, from its
 * block whether it has a record or not, unless its row only marks time
 * (its turn ran with its rider's), then every other creature this view
 * holds whose record is current, a turn's companions and mounts. A player
 * holds records only for their own creatures, so they list no other.
 */
export function turnParticipants(view: View): Participant[] {
  const encounter = view.encounter;
  if (!encounter?.activeEntryId) return [];
  const entry = encounter.entries.find((e) => e.id === encounter.activeEntryId);
  const out: Participant[] = [];
  const seen = new Set<string>();
  if (entry && !marksTime(encounter, entry)) {
    const target: ActorTarget | null = entry.tokenId !== undefined ? { tokenId: entry.tokenId } : entry.characterId !== undefined ? { characterId: entry.characterId } : null;
    if (target && (("tokenId" in target && view.tokens[target.tokenId]) || ("characterId" in target && view.characters[target.characterId]))) {
      const holder = holderKey(view, target);
      seen.add(holder);
      out.push({ target, holder, name: entryName(view, entry), record: currentRecord(encounter, actorOf(view, target)), landing: true });
    }
  }
  // Sorted by holder, so every device lists the turn's other creatures in one order.
  const others: Participant[] = [];
  for (const character of Object.values(view.characters)) {
    const record = currentRecord(encounter, character.actor);
    const holder = `c:${character.id}`;
    if (record && !seen.has(holder)) others.push({ target: { characterId: character.id }, holder, name: character.name, record, landing: false });
  }
  for (const token of Object.values(view.tokens)) {
    if (!("inline" in token.actor)) continue;
    const record = currentRecord(encounter, token.actor.inline);
    const holder = `t:${token.id}`;
    if (record && !seen.has(holder)) others.push({ target: { tokenId: token.id }, holder, name: entryName(view, { tokenId: token.id }), record, landing: false });
  }
  others.sort((a, b) => (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0));
  return [...out, ...others];
}

/**
 * Whether this viewer answers for a creature's prompts and turn card
 * (4.1): its players for a creature a player plays, the DM for any other.
 */
export function answersFor(view: Pick<RoomState, "tokens" | "characters">, you: { role: "dm" | "player"; memberId: string }, target: ActorTarget): boolean {
  if (you.role === "dm") return !playerOwnedEntry(view, target);
  return ownsEntry(view, you.memberId, target);
}

// ------------------------------------------------------------ prompts

export type PromptState = { what: PromptKey; settled: Settled | undefined };
export type RegenerationPrompt = PromptState & { what: "regeneration"; use: RegenerationUse };
export type DeathSavePrompt = PromptState & { what: "deathSave" };
export type RechargePromptState = PromptState & { key: UseKey; name: string; min: number };

/**
 * What a record holds due this turn (2.3), read from the record, never the
 * live state, but for the death save's "is it still dying". Regeneration is
 * due where the block has it, the record's HP was below the maximum or the
 * creature was not alive, and that HP met the trait's least. A death save
 * is due where the record says dying and it still is, or once settled. So
 * is each recharge in `due` whose mark is still there, or once settled.
 */
export function promptsOf(input: {
  record: TurnRecord;
  actor: Pick<ProjectedActor, "life" | "hp" | "uses">;
  regeneration: RegenerationUse | null;
  /** The block's uses, which name a recharge whose mark a roll took. */
  uses?: readonly LimitedUse[] | null;
}): { regeneration: RegenerationPrompt | null; deathSave: DeathSavePrompt | null; recharges: RechargePromptState[] } {
  const { record, actor } = input;
  const settled = (what: PromptKey) => (record.settled && Object.hasOwn(record.settled, what) ? record.settled[what] : undefined);
  let regeneration: RegenerationPrompt | null = null;
  const regen = input.regeneration;
  const max = actor.hp?.max;
  if (regen && (record.life !== "alive" || (max !== undefined && record.hp < max)) && (regen.minHp === undefined || record.hp >= regen.minHp)) {
    regeneration = { what: "regeneration", use: regen, settled: settled("regeneration") };
  }
  const deathSettled = settled("deathSave");
  const deathSave: DeathSavePrompt | null = record.life === "dying" && (actor.life === "dying" || deathSettled !== undefined) ? { what: "deathSave", settled: deathSettled } : null;
  const recharges: RechargePromptState[] = [];
  for (const key of record.due ?? []) {
    const what: PromptKey = `recharge:${key}`;
    const done = settled(what);
    const mark = actor.uses && Object.hasOwn(actor.uses, key) ? actor.uses[key] : undefined;
    if (done === undefined && mark?.kind !== "recharge") continue;
    // A roll that made it ready took its mark, name and range with it, so the block names it then, or else its key.
    const listed = input.uses?.find((u): u is RechargeUse => u.kind === "recharge" && u.key === key);
    recharges.push({ what, key, name: mark?.name ?? listed?.name ?? key.split(":")[1] ?? key, min: mark?.min ?? listed?.min ?? 6, settled: done });
  }
  return { regeneration, deathSave, recharges };
}

/** A prompt is open while nothing settled it. */
export function isOpen(prompt: PromptState | null): boolean {
  return prompt !== null && prompt.settled === undefined;
}

/**
 * Whether a creature's death save Roll waits (2.3, deathSaveWaits): while
 * this device shows its Regeneration open, since a troll "dies only if it
 * starts its turn with 0 Hit Points and doesn't regenerate". Every death
 * save Roll asks this: the card, the bar's and the token panel's, and the
 * Dice panel's row.
 */
export function deathSaveWaits(regeneration: RegenerationPrompt | null, dismissed: boolean): boolean {
  return isOpen(regeneration) && !dismissed;
}

/** The record an open roll of a creature's settles (2.3): its current one, when the prompt is still open there, else none, so the roll stays manual. */
export function openRecord(encounter: Turn, actor: Pick<Actor, "turnRecord" | "life" | "uses"> | undefined, what: PromptKey): number | undefined {
  const record = currentRecord(encounter, actor);
  if (!record || (record.settled && Object.hasOwn(record.settled, what))) return undefined;
  if (what === "deathSave") return record.life === "dying" && actor?.life === "dying" ? record.id : undefined;
  if (what.startsWith("recharge:")) {
    const key = what.slice("recharge:".length);
    return record.due?.includes(key) && actor?.uses && Object.hasOwn(actor.uses, key) ? record.id : undefined;
  }
  return record.id;
}

// ------------------------------------------------------------ the prompts' words

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Fire and Acid" in the rules' order. */
function typeList(types: readonly DamageType[]): string {
  const names = types.map(damageTypeName);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Regeneration's words (4.3), by the record's life: "Troll regenerates 15
 * HP.", "Troll is at 0 HP and regenerates 15 HP.", "Troll regenerates 15
 * HP and gets up." where healing brings back the dead, and where it does
 * not, a line that says so, with Skip alone.
 */
export function regenerationWords(name: string, amount: number, life: TurnRecord["life"], revives: boolean): { text: string; apply: boolean } {
  if (life === "dead") return revives ? { text: `${name} regenerates ${amount} HP and gets up.`, apply: true } : { text: `${name} is dead, and healing doesn't bring back the dead in this room.`, apply: false };
  if (life === "dying" || life === "stable") return { text: `${name} is at 0 HP and regenerates ${amount} HP.`, apply: true };
  return { text: `${name} regenerates ${amount} HP.`, apply: true };
}

/** The advisory note (3.4): "Recorded Fire damage may stop Regeneration." when the record's types hold a stop type, else null. */
export function regenerationNote(took: readonly DamageType[] | undefined, stops: readonly DamageType[]): string | null {
  const hit = stops.filter((t) => took?.includes(t));
  return hit.length > 0 ? `Recorded ${typeList(hit)} damage may stop Regeneration.` : null;
}

/** The note's help (4.3), so a DM does not take its absence for a rule. */
export const REGENERATION_NOTE_HELP = "Damage typed by hand is not counted.";

/** "Regenerated 15 HP." once Apply settled it. */
export function regeneratedWords(settled: Settled): string {
  return `Regenerated ${settled.total ?? 0} HP.`;
}

/** "Thorn is dying. Death save: 1 success, 2 failures." (4.4). */
export function deathSaveWords(name: string, saves: { ok: number; fail: number } | undefined): string {
  const counts = saves ? `${plural(saves.ok, "success", "successes")}, ${plural(saves.fail, "failure", "failures")}` : "none yet";
  return `${name} is dying. Death save: ${counts}.`;
}

/** A settled death save from its stored outcome (4.4), the same after a reload and after Previous. */
export function deathSaveResult(name: string, settled: Settled): string {
  const rolled = settled.total !== undefined ? `Rolled ${settled.total}` : "Rolled";
  switch (settled.outcome) {
    case "success":
      return `${rolled}: a success.`;
    case "twoFailures":
      return `${rolled}: two failures.`;
    case "regain":
      return `${rolled}: ${name} regains 1 HP.`;
    case "failure":
      return `${rolled}: a failure.`;
    default:
      return settled.state === "skipped" ? "Death save skipped" : `${rolled}.`;
  }
}

/** "Fire Breath can recharge (5–6)." (4.5). */
export function rechargeWords(name: string, min: number): string {
  return `${name} can recharge (${rechargeRange(min)}).`;
}

/** A settled recharge: "Rolled 5: Fire Breath is ready.", "Rolled 2: Fire Breath stays used.", and Mark ready's "Fire Breath is ready.". */
export function rechargeResult(name: string, settled: Settled): string {
  if (settled.state === "skipped") return `${name} recharge skipped`;
  if (settled.total === undefined) return `${name} is ready.`;
  return settled.outcome === "ready" ? `Rolled ${settled.total}: ${name} is ready.` : `Rolled ${settled.total}: ${name} stays used.`;
}

/** A skipped prompt as the turn card lists it, with Reopen: "Regeneration skipped". */
export function skippedWords(what: PromptKey, names: Readonly<Record<string, string>>): string {
  if (what === "regeneration") return "Regeneration skipped";
  if (what === "deathSave") return "Death save skipped";
  const key = what.slice("recharge:".length);
  return `${names[key] ?? "Recharge"} recharge skipped`;
}

// ------------------------------------------------------------ the list

/** Where the list stands (4.2, 5, 6): the turn card, on the creature's own turn, or the off-turn list of its row and its bar. */
export type UsesForm = "card" | "list";

/** Why a legendary action cannot be taken now, which its button says. */
export type LegendaryOff = "ownTurn" | "once" | "needs" | null;

export type LegendaryButton = { key?: UseKey; name: string; cost: number; once: boolean; off: LegendaryOff };

export type UseRow =
  /** Legendary actions with their pips left: on the card a line alone, in the list a button each, or "Spend a legendary action" for counts set by hand. */
  | { kind: "legendary"; left: number; max: number; buttons: LegendaryButton[] }
  | { kind: "resist"; left: number; max: number }
  /** A recharge, a rest or an X/Day ability of the block, with its mark when spent. */
  | { kind: "ability"; use: RechargeUse | RestUse | DayUse; mark: UseMark | undefined; rolled: Settled | undefined }
  /** A mark under a key the block no longer lists (3.2), by its stored name. */
  | { kind: "other"; key: UseKey; mark: UseMark }
  | { kind: "regeneration"; amount: number }
  | { kind: "skipped"; what: PromptKey; text: string };

export type UsesInput = {
  form: UsesForm;
  /** The block's uses, null while it loads or with none to read. */
  uses: readonly LimitedUse[] | null;
  actor: Pick<ProjectedActor, "legendary" | "uses"> | undefined;
  /** The creature acts now: its own turn, when legendary actions wait for another creature's. */
  ownTurn: boolean;
  /** Its current record, for the card's results and skipped prompts. */
  record: TurnRecord | null;
};

/**
 * The rows of a creature's uses (4.2, 5, 6), one list in three places. The
 * card leaves out legendary action buttons, since they come only after
 * another creature's turn (13.1), and Regeneration's line, which its own
 * card covers. The list adds them, and the marks its block no longer lists.
 */
export function usesRows(input: UsesInput): UseRow[] {
  const { form, actor } = input;
  const uses = input.uses ?? [];
  const marks = actor?.uses ?? {};
  const legendary = actor?.legendary;
  const rows: UseRow[] = [];
  const settled = input.record?.settled ?? {};
  if (legendary && legendary.resistMax > 0) rows.push({ kind: "resist", left: Math.max(0, legendary.resistMax - legendary.resistUsed), max: legendary.resistMax });
  if (legendary && legendary.actionsMax > 0) {
    const left = Math.max(0, legendary.actionsMax - legendary.actionsUsed);
    const actions = uses.filter((u): u is LegendaryUse => u.kind === "legendary");
    const buttons: LegendaryButton[] =
      form === "card"
        ? []
        : actions.length > 0
          ? actions.map((a) => ({ key: a.key, name: a.name, cost: a.cost, once: a.once, off: legendaryOff(a, { ownTurn: input.ownTurn, left, marks }) }))
          : [{ name: "", cost: 1, once: false, off: input.ownTurn ? "ownTurn" : left < 1 ? "needs" : null }];
    // The card lists the pips before the abilities, as its first block of numbers (4.2): Resistance, then the actions.
    rows.push({ kind: "legendary", left, max: legendary.actionsMax, buttons });
  }
  const listed = new Set<string>();
  for (const use of uses) {
    if (use.kind === "legendary") {
      listed.add(use.key);
      continue;
    }
    if (use.kind === "regeneration") {
      if (form === "list") rows.push({ kind: "regeneration", amount: use.amount });
      continue;
    }
    listed.add(use.key);
    const mark = Object.hasOwn(marks, use.key) ? marks[use.key] : undefined;
    rows.push({ kind: "ability", use, mark: mark?.kind === use.kind ? mark : undefined, rolled: use.kind === "recharge" ? settled[`recharge:${use.key}`] : undefined });
  }
  // While the block loads its keys are not known, so no mark reads as one it no longer lists.
  if (form === "list" && input.uses !== null) {
    for (const key of Object.keys(marks).sort()) {
      const mark = marks[key]!;
      if (!listed.has(key) || (mark.kind !== "turn" && !uses.some((u) => u.key === key && u.kind === mark.kind))) rows.push({ kind: "other", key, mark });
    }
  }
  if (form === "card" && input.record) {
    const names: Record<string, string> = {};
    for (const [key, mark] of Object.entries(marks)) names[key] = mark.name;
    for (const use of uses) names[use.key] = use.name;
    for (const what of Object.keys(settled).sort() as PromptKey[]) {
      if (settled[what]?.state === "skipped") rows.push({ kind: "skipped", what, text: skippedWords(what, names) });
    }
  }
  return rows;
}

function legendaryOff(action: LegendaryUse, at: { ownTurn: boolean; left: number; marks: Readonly<Record<string, UseMark>> }): LegendaryOff {
  if (at.ownTurn) return "ownTurn";
  if (Object.hasOwn(at.marks, action.key) && at.marks[action.key]!.kind === "turn") return "once";
  if (action.cost > at.left) return "needs";
  return null;
}

/** How many uses a card's folded row counts (4.2): each row a viewer can act on or read a count from, and each class resource. */
export function usesCount(rows: readonly UseRow[], resources: readonly ClassResource[] | undefined): number {
  return rows.filter((r) => r.kind === "legendary" || r.kind === "resist" || r.kind === "ability" || r.kind === "other").length + (resources?.length ?? 0);
}

// ------------------------------------------------------------ the rows' words

/** "Wing Attack (2)" for a cost above 1 (5). */
export function legendaryText(button: LegendaryButton): string {
  if (!button.name) return "Spend a legendary action";
  return button.cost > 1 ? `${button.name} (${button.cost})` : button.name;
}

/** Why a legendary action's button is off (5): "After another creature's turn", "Until the start of its next turn", "Needs 2". */
export function legendaryOffText(button: LegendaryButton): string | null {
  switch (button.off) {
    case "ownTurn":
      return "After another creature's turn";
    case "once":
      return "Until the start of its next turn";
    case "needs":
      return button.cost > 1 ? `Needs ${button.cost}` : "None left";
    default:
      return null;
  }
}

/** A legendary action's name for a screen reader (9): "Use Fiery Rays, legendary action, 3 left". */
export function legendaryLabel(button: LegendaryButton, left: number): string {
  const what = button.name ? `Use ${button.name}, legendary action` : "Spend a legendary action";
  return `${what}${button.cost > 1 ? `, costs ${button.cost}` : ""}, ${left} left`;
}

/** "Legendary actions 2 of 3", and on the card ", after other creatures' turns" (4.2). */
export function legendaryHead(row: Extract<UseRow, { kind: "legendary" }>, form: UsesForm): string {
  return `Legendary actions ${row.left} of ${row.max}${form === "card" ? ", after other creatures' turns" : ""}`;
}

/** "Legendary Resistance 2 of 3", in the list and on the card alike (4.2, 5): its Use button's name says how many are left. */
export function resistHead(row: Extract<UseRow, { kind: "resist" }>): string {
  return `Legendary Resistance ${row.left} of ${row.max}`;
}

/** An ability's line: "Fire Breath, Recharge 5–6", "Phantasms, after a rest", "Dominate Mind, 2/Day, 2 left". */
export function abilityHead(row: Extract<UseRow, { kind: "ability" }>): string {
  const { use, mark } = row;
  if (use.kind === "recharge") return `${use.name}, Recharge ${rechargeRange(use.min)}`;
  if (use.kind === "rest") return `${use.name}, after a rest`;
  return `${use.name}, ${use.max}/Day, ${dayLeft(use, mark)} left`;
}

export function dayLeft(use: DayUse, mark: UseMark | undefined): number {
  return Math.max(0, use.max - (mark?.used ?? 0));
}

/**
 * An ability's state words on its line: "Ready", "Used", or a recharge
 * roll's "Rolled 5: ready". Null for an X/Day ability, whose line counts.
 * A roll speaks only while the mark still says what it left: a spend after
 * a ready roll, or Mark ready after a used one, changed it, and the line
 * then says what the mark says now, as its buttons do. The turn's prompt
 * roll is tried first, then `ownRoll`, the list's own Roll recharge.
 */
export function abilityState(row: Extract<UseRow, { kind: "ability" }>, ownRoll?: number): string | null {
  const { use } = row;
  if (use.kind === "day") return null;
  const marked = row.mark !== undefined;
  const rolls = [
    row.rolled?.total !== undefined ? { total: row.rolled.total, ready: row.rolled.outcome === "ready" } : null,
    ownRoll !== undefined && use.kind === "recharge" ? { total: ownRoll, ready: ownRoll >= use.min } : null,
  ];
  const standing = rolls.find((r) => r !== null && r.ready !== marked);
  if (standing) return `Rolled ${standing.total}: ${standing.ready ? "ready" : "used"}`;
  return marked ? "Used" : "Ready";
}

/** An other mark's line, by its stored name: "Frost Breath, used", "Dominate Mind, 1 of 2 used". */
export function otherHead(mark: UseMark): string {
  return mark.kind === "day" && mark.max > 1 ? `${mark.name}, ${mark.used} of ${mark.max} used` : `${mark.name}, used`;
}

/** Regeneration's line in the list (5): "Regeneration: 15 HP at the start of its turn". */
export function regenerationLine(amount: number): string {
  return `Regeneration: ${amount} HP at the start of its turn`;
}

// ------------------------------------------------------------ the ops

export function legendaryOp(target: ActorTarget, button: LegendaryButton): ClientOp {
  const use: Extract<ClientOp, { t: "actor.use" }>["use"] =
    button.key !== undefined ? { kind: "legendary", cost: button.cost, key: button.key, name: button.name, ...(button.once ? { once: true as const } : {}) } : { kind: "legendary", cost: 1 };
  return { t: "actor.use", target, use };
}

export function resistOp(target: ActorTarget, back = false): ClientOp {
  return { t: "actor.use", target, use: { kind: "resist" }, ...(back ? { back: true as const } : {}) };
}

/** What an ability's op carries of it, its section aside. */
export type AbilityFacts = Omit<RechargeUse, "section"> | Omit<RestUse, "section"> | Omit<DayUse, "section">;

/** Spends or restores one use of a block's ability, its facts read from the block (3.2). `ifReady` is the Dice panel's mark. */
export function abilityOp(target: ActorTarget, use: AbilityFacts, opts: { back?: boolean; ifReady?: boolean; quiet?: boolean } = {}): ClientOp {
  return {
    t: "actor.use",
    target,
    use: {
      kind: "ability",
      key: use.key,
      name: use.name,
      limit: use.kind,
      max: use.kind === "day" ? use.max : 1,
      ...(use.kind === "recharge" ? { min: use.min } : {}),
      ...(use.kind === "day" && use.short ? { short: true as const } : {}),
      ...(opts.ifReady && !opts.back ? { ifReady: true as const } : {}),
    },
    ...(opts.back ? { back: true as const } : {}),
    ...(opts.quiet ? { quiet: true as const } : {}),
  };
}

/** Restore for a mark the block no longer lists, from what the mark keeps (3.2). */
export function otherBackOp(target: ActorTarget, key: UseKey, mark: UseMark): ClientOp {
  if (mark.kind === "turn") return { t: "actor.use", target, use: { kind: "legendary", cost: 1, key, name: mark.name }, back: true };
  return {
    t: "actor.use",
    target,
    use: { kind: "ability", key, name: mark.name, limit: mark.kind, max: mark.kind === "day" ? mark.max : 1, ...(mark.kind === "recharge" ? { min: mark.min ?? 6 } : {}), ...(mark.short ? { short: true as const } : {}) },
    back: true,
  };
}

export function rechargeRollOp(tag: string, target: ActorTarget, use: { key: UseKey; name: string; min: number }, record: number | undefined): Extract<ClientOp, { t: "actor.rechargeRoll" }> {
  return { t: "actor.rechargeRoll", tag, target, key: use.key, name: use.name, min: use.min, ...(record !== undefined ? { record } : {}) };
}

export function promptOp(target: ActorTarget, record: number, what: PromptKey, state: "skipped" | "open"): ClientOp {
  return { t: "actor.prompt", target, record, what, state };
}

export function regenerateOp(target: ActorTarget, use: RegenerationUse, record: number): ClientOp {
  return { t: "actor.use", target, use: { kind: "regenerate", key: use.key, amount: use.amount, record } };
}

// ------------------------------------------------------------ the tracker row's chips

/**
 * The DM's chips on a tracker row for its spent uses (5), after LA and LR,
 * from the marks' names: "Fire Breath used", and "Dominate Mind 1/2" (left
 * over the most, as LA's) for a spent X/Day. At most 3, then "+2 more",
 * since rows already wrap on phones (13.15). Each keeps its mark's key,
 * since two sections may print abilities of one name.
 */
export function markChips(marks: Readonly<Record<string, UseMark>> | undefined): { chips: { key: UseKey; text: string }[]; more: number } {
  const all = Object.keys(marks ?? {})
    .sort()
    .map((key) => {
      const mark = marks![key]!;
      return { key, text: mark.kind === "day" && mark.max > 1 ? `${mark.name} ${mark.max - mark.used}/${mark.max}` : `${mark.name} used` };
    });
  return { chips: all.slice(0, 3), more: Math.max(0, all.length - 3) };
}

/**
 * Whether a creature shows a Uses button or group (6): only where its list
 * (`usesRows`, the `list` form) has a row or it has class resources, so
 * neither ever opens empty. Before its block is read, spent uses show at
 * once, with the list's loading line where their rows will stand, and a
 * creature with nothing yet is held while its block loads.
 */
export function usesPresence(input: { actor: Pick<ProjectedActor, "legendary" | "uses"> | undefined; resources: readonly unknown[] | undefined; uses: readonly LimitedUse[] | null; loading: boolean }): "yes" | "loading" | "no" {
  if ((input.resources?.length ?? 0) > 0) return "yes";
  if (usesRows({ form: "list", uses: input.uses, actor: input.actor, ownTurn: false, record: null }).length > 0) return "yes";
  if (input.uses !== null) return "no";
  if (Object.keys(input.actor?.uses ?? {}).length > 0) return "yes";
  return input.loading ? "loading" : "no";
}
