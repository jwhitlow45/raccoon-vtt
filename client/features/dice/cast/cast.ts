import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import type { AreaTemplate, CastAsk, LogEntry, RoomState, Token, Viewer } from "#shared/model.ts";
import { ASKS_WAITING, waitingAsks } from "#shared/permissions.ts";
import type { ActorTarget, CastInput, ClientOp } from "#shared/protocol.ts";
import { labelDamageType } from "#shared/reducer/casts.ts";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import { damageTypeName } from "#shared/rules/damage.ts";
import { AREA_SPELLS, type AreaSpell } from "#shared/srd/area-spells.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { scopeSlot } from "../../../state/scope.ts";
import type { OnAnswer } from "../../../state/types.ts";
import type { AreaCreature } from "../../areas/caster.ts";
import { areaTitle } from "../../areas/labels.ts";
import { rollsOf } from "../logic.ts";
import { creatureKey, cutLabel } from "../options.ts";
import { ReceiptTracker, type ReceiptState } from "../useReceipt.ts";
import type { PanelRoll } from "../useDicePanel.ts";
import type { FillInput } from "../groupSave/fills.ts";
import { parseParts } from "../groupSave/outcome.ts";
import type { CastBlock, OptionState } from "../optionState.ts";

/**
 * A player's ask for saves (docs/design-v1-player-save-spell.md 3.1 and
 * 3.2): what the block reads from the player's own view, the op it sends,
 * and the sends it keeps until each settles. The block rolls the damage
 * first, on the same socket, so the server copies that roll into the ask.
 * Plain functions over a small store, so the send's rules are tested
 * without React.
 */

/** The caster: the picked creature's token on this scene, the character's own for a character. */
export function casterToken(view: Pick<RoomState, "tokens">, creature: ActorTarget, sceneId: string | null): Token | undefined {
  if (sceneId === null) return undefined;
  if ("tokenId" in creature) {
    const token = view.tokens[creature.tokenId];
    return token?.sceneId === sceneId ? token : undefined;
  }
  return Object.values(view.tokens).find((t) => t.sceneId === sceneId && "ref" in t.actor && t.actor.ref === creature.characterId);
}

/** A targets ask's targets: the selected tokens this view holds on the scene, less the caster, in the order selected. */
export function selectionTargets(view: Pick<RoomState, "tokens">, selected: readonly string[], casterId: string | undefined, sceneId: string | null): string[] {
  return [...new Set(selected)].filter((id) => id !== casterId && view.tokens[id]?.sceneId === sceneId);
}

/** The name an area's ask goes by: its spell's, else its label, else its shape's. */
export function areaSpellName(t: Pick<AreaTemplate, "spell" | "label" | "shape" | "size">): string {
  return t.spell ?? t.label ?? areaTitle(t);
}

/**
 * The block an area's Ask for saves opens (3.1): on the area's caster when
 * it is one of the player's creatures here, else on the creature the panel
 * has picked when it stands here, else on their first creature here. Null
 * with none of theirs on this scene, the From control's case.
 */
export function areaAskSpec(input: { creatures: readonly Pick<AreaCreature, "tokenId" | "characterId">[]; view: Pick<RoomState, "tokens">; template: Pick<AreaTemplate, "id" | "casterId" | "spell" | "label" | "shape" | "size">; picked: string | null }): CastBlock | null {
  const keyOf = (c: Pick<AreaCreature, "tokenId" | "characterId">) => (c.characterId !== undefined ? `c:${c.characterId}` : creatureKey(input.view, { tokenId: c.tokenId }));
  const pick = input.creatures.find((c) => c.tokenId === input.template.casterId) ?? input.creatures.find((c) => keyOf(c) === input.picked) ?? input.creatures[0];
  if (!pick) return null;
  const creature: ActorTarget = pick.characterId !== undefined ? { characterId: pick.characterId } : { tokenId: pick.tokenId };
  return { key: keyOf(pick), creature, spell: areaSpellName(input.template), area: input.template.id };
}

/** Opening a block (3.1): one at a time, and the panel's pick pinned to its creature, so selecting targets never moves it. */
export function openedBlock(spec: CastBlock): Pick<OptionState, "cast" | "picked"> {
  return { cast: spec, picked: spec.key };
}

/** Whether a row's name is the spell's, as the group save finds a caster's own spell by name (groupSave/fills.ts ownSpell). */
export function sameSpell(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The block's casting level (3.1): every leveled spell gets one, from its
 * own level to 9. Where the row has a stepper (pcSlots scales its damage)
 * it is the row's, and `own` is false. Elsewhere the block shows its own,
 * as for Hold Person. A cantrip and a save action have none.
 */
export function blockLevel(input: { level: number | undefined; rowSlot: number | null; picked: number | undefined }): { min: number; value: number; own: boolean } | null {
  if (input.level === undefined || input.level < 1) return null;
  if (input.rowSlot !== null) return { min: input.level, value: input.rowSlot, own: false };
  return { min: input.level, value: Math.max(input.level, Math.min(9, input.picked ?? input.level)), own: true };
}

/** A spell's level: its row's for a spell on the stat block, else its area preset's. */
export function spellLevel(named: Pick<NamedRoll, "section" | "level"> | null, spell: string): number | undefined {
  if (named) return named.section === "spells" ? named.level : undefined;
  return AREA_SPELLS.find((p) => sameSpell(p.name, spell))?.level;
}

/** The area preset of a spell's name, whose area a targets ask may place instead (3.1). */
export function areaPresetOf(spell: string): AreaSpell | undefined {
  return AREA_SPELLS.find((p) => sameSpell(p.name, spell));
}

/**
 * The damage a fill's field names, as the caster's own rolls: an SRD
 * preset cast by a creature with no stat block, whose block has no row to
 * roll it from. Each part with dice under its type, labelled as a row's
 * Damage labels it.
 */
export function fillRolls(spell: string, damage: string, creature: ActorTarget): PanelRoll[] {
  const parsed = parseParts(damage);
  if (!parsed.ok) return [];
  return parsed.parts.flatMap((p) => ("formula" in p ? [{ formula: p.formula, label: cutLabel(`${spell} damage${p.type ? `, ${damageTypeName(p.type)}` : ""}`), creature }] : []));
}

/** The block's first line, from the player's own fill: "Dexterity save, DC 15, against Fireball at level 4". */
export function fillLine(fill: Pick<FillInput, "test" | "dc"> | null, spell: string, slot: number | undefined): string {
  const against = `${spell}${slot !== undefined ? ` at level ${slot}` : ""}`;
  if (!fill) return `Against ${against}. The DM sets the save and the DC.`;
  if (fill.test.kind === "none") return `No save, against ${against}`;
  const ability = ABILITY_NAMES[fill.test.ability];
  const what = fill.test.kind === "save" ? `${ability} save` : `${ability} check`;
  return fill.dc === null ? `${what} against ${against}. The DM sets the DC.` : `${what}, DC ${fill.dc}, against ${against}`;
}

/** The damage a send rolls as words: "9d6 Fire", "9d6 Fire + 2d8 Radiant". */
export function rollWords(rolls: readonly PanelRoll[]): string {
  return rolls
    .map((r) => {
      const type = labelDamageType(r.label);
      return `${r.formula}${type ? ` ${damageTypeName(type)}` : ""}`;
    })
    .join(" + ");
}

/**
 * The block's send buttons (3.1): with damage, "Roll 9d6 Fire and ask" and
 * "Ask, the DM rolls". With none, one "Ask the DM", and for a preset with
 * no save "Ask the DM to apply".
 */
export function sendWords(input: { rolls: readonly PanelRoll[]; save: boolean }): { first: string; dmRolls: string | null } {
  if (input.rolls.length > 0) return { first: `Roll ${rollWords(input.rolls)} and ask`, dmRolls: "Ask, the DM rolls" };
  return { first: input.save ? "Ask the DM" : "Ask the DM to apply", dmRolls: null };
}

/** The words a targets line starts with: "Targets (2): Goblin 1, Goblin 2". */
export function targetsLine(names: readonly string[]): string {
  return names.length === 0 ? "Select the creatures it targets on the map." : `Targets (${names.length}): ${names.join(", ")}`;
}

/** The refusal of a send with no target, on the disabled button. */
export const SELECT_TARGETS = "Select the creatures it targets";

/**
 * Why the block cannot send now, else null (3.1): no connection or a
 * preview, no caster token on this scene, a targets ask with none, or
 * three asks waiting, counted as the server counts them.
 */
export function sendBlocked(input: { blocked: string | null; casterName: string; caster: Token | undefined; targets: number | null; waiting: number }): string | null {
  if (input.blocked) return input.blocked;
  if (!input.caster) return `${input.casterName} is not on this scene.`;
  if (input.targets === 0) return SELECT_TARGETS;
  if (input.waiting >= LIMITS.castsPerMember) return ASKS_WAITING;
  return null;
}

/** The asks that count against the viewer's cap, from their own view, as the server counts them. */
export function waitingCount(view: Pick<RoomState, "casts" | "tokens" | "characters">, you: Viewer): number {
  return waitingAsks(view, you).length;
}

/** The ask an open block sends, less its id and its damage roll, which the send adds. */
export function askInput(input: { caster: string; sceneId: string; spell: string; slot?: number | undefined; area?: string | undefined; targets: readonly string[]; roll?: string | undefined }): Omit<CastInput, "id" | "damage"> {
  const out: Omit<CastInput, "id" | "damage"> = { caster: input.caster, sceneId: input.sceneId, spell: cutLabel(input.spell) };
  if (input.slot !== undefined) out.slot = input.slot;
  if (input.area !== undefined) out.area = input.area;
  else {
    out.targets = input.targets.slice(0, LIMITS.rollTargets);
    if (input.roll !== undefined) out.roll = input.roll;
  }
  return out;
}

/** What a committed roll rolled, by type: "Rolled 31 Fire", "Rolled 31 Fire + 9 Radiant". Null without a line. */
export function rolledText(lines: readonly LogEntry[]): string | null {
  const rolls = rollsOf(lines);
  if (rolls.length === 0) return null;
  return `Rolled ${rolls.map((r) => `${r.total.toLocaleString("en-US")}${labelDamageType(r.label) ? ` ${damageTypeName(labelDamageType(r.label)!)}` : ""}`).join(" + ")}`;
}

// ------------------------------------------------------------ sends

/** An ask this page sent, kept until it settles: its id is its receipt tag, and `ask` is what Ask again sends anew. */
export type CastSend = {
  id: string;
  /** The creature's key, whose row or block shows it. */
  key: string;
  spell: string;
  /** The row's named roll, or the area, as the block was opened for. */
  roll?: string;
  area?: string;
  ask: Omit<CastInput, "id" | "damage">;
  /** The caster's damage roll it named, which Ask again names again, never rolling it twice (3.1). */
  damage?: { tag: string; parts: number };
};

export type CastSends = { sends: Record<string, CastSend>; withdrawing: Record<string, true> };

/** One Room page's unsettled asks (client/state/scope.ts). */
export const castSendsSlot = scopeSlot(() => createStore<CastSends>(() => ({ sends: {}, withdrawing: {} })));

/**
 * The asks' receipts by ask id, in a tracker of their own: the rolls'
 * tracker toasts a settled tag no surface shows, and an ask is no roll
 * (useRollToasts).
 */
export const castReceiptsSlot = scopeSlot(() => new ReceiptTracker());

/** Where a send stands: waiting for its answer, asked (in the view), refused, unknown, or settled and gone from the view. */
export type CastPhase = "sending" | "asked" | "refused" | "unknown" | "closed";

export function phaseOf(state: ReceiptState | null, inView: boolean): CastPhase {
  if (inView) return "asked";
  if (state === null || state.state === "sending" || state.state === "checking") return "sending";
  if (state.state === "refused") return "refused";
  if (state.state === "unknown") return "unknown";
  return "closed";
}

/** The words a refused or unknown send shows, doc 1's for an unknown (8.7). */
export function sendSays(state: ReceiptState | null): string | null {
  if (state?.state === "refused") return state.text || state.message;
  if (state?.state === "unknown") return "This may have happened. Check the log.";
  return null;
}

/** What a send needs from the room, apart from React. */
export type CastEnv = {
  store: StoreApi<CastSends>;
  tracker: Pick<ReceiptTracker, "sending" | "answer" | "forget" | "state" | "lookup">;
  connected(): boolean;
  dispatch(op: ClientOp, opts: { quiet: true; onAnswer: OnAnswer }): number | null;
  /** Rolls the damage as a Dice panel roll: its tag and how many batches it went in, or null for nothing sent. */
  rollDamage(rolls: PanelRoll[]): { tag: string; parts: number } | null;
  newId(): string;
  view(): Pick<RoomState, "casts"> | null;
  /** The unsettled sends, kept for a reload (castDraft). */
  save(sends: readonly CastSend[]): void;
  notify(text: string): void;
};

/** A send still waits for its answer, so a second tap on its block does nothing. */
function unsettled(env: CastEnv, send: CastSend): boolean {
  return phaseOf(env.tracker.state(send.id), env.view()?.casts[send.id] !== undefined) === "sending";
}

function persist(env: CastEnv): void {
  const sends = env.store.getState().sends;
  const view = env.view();
  env.save(Object.values(sends).filter((s) => view?.casts[s.id] === undefined && env.tracker.state(s.id)?.state !== "committed"));
}

/** The send of a block, for its creature and spell, that still waits, if any. */
export function busySend(env: CastEnv, key: string, spell: string): CastSend | undefined {
  return Object.values(env.store.getState().sends).find((s) => s.key === key && s.spell === spell && unsettled(env, s));
}

/**
 * One tap of the block's send (3.1): with `rolls`, the damage first as a
 * Dice panel roll, then the ask naming it, on the same socket and in that
 * order. Nothing goes while the block's last send still waits, or without
 * a connection. Returns the ask's id, or null for nothing asked.
 */
export function askFor(env: CastEnv, input: { key: string; spell: string; roll?: string; area?: string; ask: Omit<CastInput, "id" | "damage">; rolls: PanelRoll[] | null }): string | null {
  if (busySend(env, input.key, input.spell) || !env.connected()) return null;
  let damage: CastSend["damage"];
  if (input.rolls && input.rolls.length > 0) {
    const rolled = env.rollDamage(input.rolls);
    if (!rolled) return null;
    damage = rolled;
  }
  return send(env, { key: input.key, spell: input.spell, ask: input.ask, ...(input.roll !== undefined ? { roll: input.roll } : {}), ...(input.area !== undefined ? { area: input.area } : {}), ...(damage ? { damage } : {}) });
}

/**
 * A refused or unknown send asked again (3.1): a new ask, naming the same
 * roll and never rolling it again. `ask` is the block's ask as it stands
 * now, where the block is open, else the one first sent.
 */
export function askAgain(env: CastEnv, id: string, ask?: Omit<CastInput, "id" | "damage">): string | null {
  const old = env.store.getState().sends[id];
  if (!old || !env.connected()) return null;
  const phase = phaseOf(env.tracker.state(id), env.view()?.casts[id] !== undefined);
  if (phase !== "refused" && phase !== "unknown") return null;
  const next = send(env, { ...old, ask: ask ?? old.ask });
  if (next !== null) forgetSend(env, id);
  return next;
}

function send(env: CastEnv, base: Omit<CastSend, "id">): string | null {
  const id = env.newId();
  const record: CastSend = { ...base, id };
  const op: ClientOp = { t: "cast.ask", cast: { ...base.ask, id, ...(base.damage ? { damage: base.damage } : {}) } };
  env.tracker.sending(id, 0);
  env.store.setState((s) => ({ sends: { ...s.sends, [id]: record } }));
  const n = env.dispatch(op, {
    quiet: true,
    onAnswer: (answer, refusal, cause) => {
      env.tracker.answer(id, 0, answer, refusal, cause);
      if (answer === "taken") env.notify(`Asked the DM for saves against ${base.spell}.`);
      persist(env);
    },
  });
  if (n === null) {
    // A roll that went without its ask is kept, so Ask again names it rather than rolling again.
    if (base.damage) env.tracker.answer(id, 0, "refused", { code: "invalid", message: "The ask did not go. Ask again.", text: "The ask did not go. Ask again." });
    else {
      env.tracker.forget(id, 0);
      env.store.setState((s) => {
        const { [id]: _gone, ...sends } = s.sends;
        return { sends };
      });
      return null;
    }
  }
  persist(env);
  return id;
}

/** Drops a settled send the person closed: a refusal or an unknown they read. */
export function forgetSend(env: CastEnv, id: string): void {
  env.store.setState((s) => {
    const { [id]: _gone, ...sends } = s.sends;
    return { sends };
  });
  persist(env);
}

/** A player's Withdraw (3.2): closes the ask, busy until it leaves the view or is refused. */
export function withdrawAsk(env: CastEnv, askId: string): number | null {
  if (env.store.getState().withdrawing[askId] || !env.connected()) return null;
  env.store.setState((s) => ({ withdrawing: { ...s.withdrawing, [askId]: true } }));
  const done = () =>
    env.store.setState((s) => {
      const { [askId]: _gone, ...withdrawing } = s.withdrawing;
      return { withdrawing };
    });
  const n = env.dispatch({ t: "cast.close", castId: askId, end: "withdrawn" }, {
    quiet: true,
    onAnswer: (answer, refusal) => {
      done();
      if (answer === "refused") env.notify(refusal?.text ?? refusal?.message ?? "Not withdrawn.");
    },
  });
  if (n === null) done();
  return n;
}

/** A waiting line (3.2): an ask in the view, or a send that waits for its answer. */
export type WaitingLine = { id: string; spell: string; caster: string; asked: boolean };

/**
 * Every waiting ask of the player's, the asks in their view (the
 * projection holds only those whose caster they own) and the sends still
 * waiting for an answer, oldest first.
 */
export function waitingLines(view: Pick<RoomState, "casts">, sends: Readonly<Record<string, CastSend>>, state: (id: string) => ReceiptState | null): WaitingLine[] {
  const out: WaitingLine[] = Object.values(view.casts)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .map((ask: CastAsk) => ({ id: ask.id, spell: ask.spell, caster: ask.caster, asked: true }));
  for (const send of Object.values(sends)) {
    if (view.casts[send.id] !== undefined) continue;
    if (phaseOf(state(send.id), false) === "sending") out.push({ id: send.id, spell: send.spell, caster: send.ask.caster, asked: false });
  }
  return out;
}

/**
 * Brings back the sends a reload left unsettled (3.2) and settles each by
 * its receipt, looked up once. Nothing is sent again: an unknown stays
 * unknown until the person acts.
 */
export function restoreSends(env: CastEnv, sends: readonly CastSend[]): void {
  if (sends.length === 0) return;
  env.store.setState((s) => ({ sends: { ...Object.fromEntries(sends.map((x) => [x.id, x])), ...s.sends } }));
  for (const send of sends) void env.tracker.lookup(send.id).then(() => persist(env));
}

// ------------------------------------------------------------ the session draft

const draftKey = (roomId: string) => `rvtt.castAsk.${roomId}`;

/** The unsettled sends a reload settles, kept in session storage as the group save keeps its draft. */
export function readCastDraft(roomId: string, storage: Pick<Storage, "getItem"> | undefined = sessionStore()): CastSend[] {
  try {
    const raw = storage?.getItem(draftKey(roomId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is CastSend => typeof s === "object" && s !== null && typeof (s as CastSend).id === "string" && typeof (s as CastSend).key === "string" && typeof (s as CastSend).ask === "object") : [];
  } catch {
    return [];
  }
}

export function writeCastDraft(roomId: string, sends: readonly CastSend[], storage: Pick<Storage, "setItem" | "removeItem"> | undefined = sessionStore()): void {
  try {
    if (sends.length === 0) storage?.removeItem(draftKey(roomId));
    else storage?.setItem(draftKey(roomId), JSON.stringify(sends));
  } catch {
    // A full or blocked storage loses only the reload's settling, never the ask.
  }
}

function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ closing toasts

/** The toast when an ask's closing line arrives (3.2): the same for an Apply and a close with nothing to apply. */
export function closedText(line: { spell: string; end?: "done" | "dismissed" | "withdrawn" }): string | null {
  if (line.end === "done") return `The DM resolved ${line.spell}.`;
  if (line.end === "dismissed") return `The DM set ${line.spell} aside.`;
  return null;
}
