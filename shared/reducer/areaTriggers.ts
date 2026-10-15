import type { AreaTemplate, AreaTrigger, LogEntry, RoomState, Token } from "../model.ts";
import { seenByNonOwners } from "../project.ts";
import { MAX_NAME, type Op } from "../protocol.ts";
import { creaturesInArea, type AreaContext, type AreaToken } from "../rules/aoe.ts";
import { sceneWalls } from "../rules/walls.ts";
import type { Tx } from "./tx.ts";

/**
 * Reminders that an area hits a creature again (features section 9): the
 * log line "Goblin 2 ended its turn in Spirit Guardians". An area says when
 * it hits in `AreaTemplate.triggers`, and these hooks around the reducer
 * write an `area` event when that happens:
 *
 * - `enter`: during a turn, a creature comes to be inside the area, by its
 *   own move or by the area moving onto it (Spirit Guardians following its
 *   cleric, Moonbeam moved). SRD 5.2.1 counts both for the spells that move.
 *   Placing an area is not entering it: what it does when it appears is
 *   the caster's damage, dealt from the area itself.
 * - `turnStart` and `turnEnd`: the creature whose turn starts or ends with
 *   `encounter.next` is inside, and for `turnStart` also a turn the removal
 *   of the acting row passed on. Previous and an undo start no turn.
 *
 * Most of these spells hit a creature "only once per turn", so such an
 * area (`oncePerTurn`) reminds about one creature at most once a turn,
 * whichever trigger comes first. The others limit each trigger on its own:
 * Web and Sleet Storm hit "the first time" a creature enters on a turn and
 * again when it starts a turn there, and a creature that enters Grease and
 * ends its turn there saves twice. So without the mark each trigger reminds
 * about a creature once a turn. A turn is everything since the last `turn`
 * line in the log.
 *
 * The reminders are log events, so the projection decides who reads them
 * (design 7.3): the DM always, a player only while they can see both the
 * creature and the area, and never what happened out of their sight. They
 * are written only while a turn is running, so nothing here costs anything
 * outside a fight, or in a fight with no such area on the scene.
 */

/** Whether a turn is running: the server's encounter, or a player's projection of a hidden creature's turn. */
function inTurn(state: RoomState): boolean {
  const encounter = state.encounter;
  return !!encounter && (encounter.activeEntryId !== null || encounter.started === true);
}

/** Areas on a scene that hit on `trigger`, by id, so a replay writes their lines in the same order. */
function triggering(state: RoomState, sceneId: string, trigger: AreaTrigger): AreaTemplate[] {
  return Object.values(state.templates)
    .filter((t) => t.sceneId === sceneId && (t.triggers?.includes(trigger) ?? false))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A creature an area can hit: not an object, and not dead. */
function isCreature(state: RoomState, token: Token): boolean {
  if (token.kind === "object") return false;
  const actor = "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
  return actor?.life !== "dead";
}

function contextOf(state: RoomState, sceneId: string): AreaContext | null {
  const scene = state.scenes[sceneId];
  if (!scene) return null;
  return {
    settings: state.meta.settings,
    bounds: scene.bounds,
    // Keyed on the scene's chunk objects and automatic walls rule, never on the walls version (walls.ts).
    walls: sceneWalls(scene, state.buildChunks),
    tokens: state.tokens as Readonly<Record<string, AreaToken>>,
  };
}

/** The ids of `candidates` inside the area. */
function inside(state: RoomState, template: AreaTemplate, candidates: readonly Token[]): Set<string> {
  const ctx = contextOf(state, template.sceneId);
  if (!ctx || candidates.length === 0) return new Set();
  return new Set(creaturesInArea(template, candidates, ctx));
}

/**
 * Whether the log already reminded about this creature and area in the turn
 * that is running: for any trigger when the area hits once a turn, else for
 * this one.
 */
function remindedThisTurn(log: readonly LogEntry[], template: AreaTemplate, tokenId: string, trigger: AreaTrigger): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const data = log[i]!.data;
    if (data?.type === "turn") return false;
    if (data?.type !== "area" || data.templateId !== template.id || data.tokenId !== tokenId) continue;
    if (template.oncePerTurn === true || data.trigger === trigger) return true;
  }
  return false;
}

/** "Spirit Guardians", or "20 ft sphere" for an area with no name, as the area tool titles it. */
function areaName(t: AreaTemplate): string {
  return (t.spell || t.label || `${t.size} ft ${t.shape}`).slice(0, MAX_NAME);
}

/**
 * Writes the reminder, marked by what players could see where it happened
 * (`at`, the room at that moment, by default as the op left it). A swept
 * entry happened partway along the leg (alongLeg), so the creature and the
 * token the area follows are judged where they stood then: a crossing made
 * under fog stays out of players' log even when the move ends in the open,
 * and so does the route of a cleric whose aura swept over a goblin from
 * the dark.
 */
function remind(tx: Tx, template: AreaTemplate, token: Token, trigger: AreaTrigger, areaMoved: boolean, at: RoomState = tx.state): void {
  if (remindedThisTurn(tx.state.log, template, token.id, trigger)) return;
  const attached = template.attachedTo !== undefined ? at.tokens[template.attachedTo] : undefined;
  const hidden = template.visibility === "dm" || (attached !== undefined && !seenByNonOwners(at, attached, tx.env));
  const there = at.tokens[token.id] ?? token;
  tx.addEvent({
    type: "area",
    templateId: template.id,
    tokenId: token.id,
    trigger,
    area: areaName(template),
    ...(areaMoved ? { moved: true as const } : {}),
    ...(seenByNonOwners(at, there, tx.env) ? { seen: true as const } : {}),
    ...(hidden ? { hidden: true as const } : {}),
  });
}

/** The token whose turn is the encounter's active one, if it is a creature an area can hit. */
function activeCreature(state: RoomState): Token | undefined {
  const encounter = state.encounter;
  const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  const token = entry?.tokenId !== undefined ? state.tokens[entry.tokenId] : undefined;
  return token && isCreature(state, token) ? token : undefined;
}

function remindAtTurn(tx: Tx, trigger: "turnStart" | "turnEnd"): void {
  const token = activeCreature(tx.state);
  if (!token) return;
  for (const template of triggering(tx.state, token.sceneId, trigger)) {
    if (inside(tx.state, template, [token]).has(token.id)) remind(tx, template, token, trigger, false);
  }
}

/**
 * Whether the op started a turn: `encounter.next`, or the removal of the
 * acting row passing the turn on. Each writes the turn's line, and only a
 * turn that starts does: Previous writes one taken back, and an undo none.
 */
function startedTurn(tx: Tx): boolean {
  return tx.log.some((e) => e.data?.type === "turn" && e.data.back !== true);
}

/** Before `encounter.next` reduces: the creature whose turn ends, in the areas that hit then. */
export function remindTurnEnd(tx: Tx): void {
  remindAtTurn(tx, "turnEnd");
}

/** The fields that place a token: where it stands, how high, how big, and on which scene. */
function placeChanged(a: Token | undefined, b: Token | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.sceneId !== b.sceneId ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.elevation !== b.elevation ||
    a.size !== b.size ||
    a.w !== b.w ||
    a.h !== b.h ||
    a.height !== b.height
  );
}

/** The tokens an op moved, and whether it moved an area. */
function movedBy(op: Op, before: RoomState, after: RoomState): { tokens: Set<string>; templateId: string | null } {
  const tokens = new Set<string>();
  const ids =
    op.t === "token.move" ? [op.tokenId] : op.t === "token.moveMany" ? op.moves.map((m) => m.tokenId) : op.t === "token.update" ? [op.tokenId] : [];
  for (const id of ids) if (placeChanged(before.tokens[id], after.tokens[id])) tokens.add(id);
  return { tokens, templateId: op.t === "template.update" ? op.templateId : null };
}

/*
 * A move, or an area's move, is one straight leg from where it was to where
 * it is: a drop, however the drag went. A creature that crosses an area and
 * ends outside it entered it on the way, so the leg is swept. The moved
 * tokens and the moved area are put at points along it every half cell,
 * close enough that no leg steps over an area a cell wide, and a creature
 * inside the area at any of them, though not where the leg began, entered
 * it. A token sent to another scene has no leg, only where it lands.
 */
const SWEEP_STEP = 0.5;
/** Enough for a leg across the largest scene (design 10.5) at SWEEP_STEP. */
const MAX_SWEEP_POINTS = 600;

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** The room at each point along the op's leg after it began, ending with `after` itself. */
function alongLeg(before: RoomState, after: RoomState, moved: { tokens: Set<string>; templateId: string | null }): RoomState[] {
  const fpc = after.meta.settings.feetPerCell;
  let reach = 0;
  const tokens: [Token, Token][] = [];
  for (const id of moved.tokens) {
    const from = before.tokens[id];
    const to = after.tokens[id];
    if (!from || !to || from.sceneId !== to.sceneId) continue;
    tokens.push([from, to]);
    reach = Math.max(reach, Math.abs(to.x - from.x), Math.abs(to.y - from.y), Math.abs(to.elevation - from.elevation) / fpc);
  }
  const fromArea = moved.templateId !== null ? before.templates[moved.templateId] : undefined;
  const toArea = moved.templateId !== null ? after.templates[moved.templateId] : undefined;
  const areaLeg = fromArea && toArea && fromArea.sceneId === toArea.sceneId ? ([fromArea, toArea] as const) : null;
  if (areaLeg) {
    const [a, b] = [areaLeg[0].origin, areaLeg[1].origin];
    reach = Math.max(reach, Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z) / fpc);
  }
  const points = Math.min(MAX_SWEEP_POINTS, Math.max(1, Math.ceil(reach / SWEEP_STEP)));
  const out: RoomState[] = [];
  for (let k = 1; k < points; k++) {
    const f = k / points;
    const placed = { ...after.tokens };
    for (const [from, to] of tokens) placed[to.id] = { ...to, x: lerp(from.x, to.x, f), y: lerp(from.y, to.y, f), elevation: lerp(from.elevation, to.elevation, f) };
    let templates = after.templates;
    if (areaLeg) {
      const [from, to] = areaLeg;
      const origin = { x: lerp(from.origin.x, to.origin.x, f), y: lerp(from.origin.y, to.origin.y, f), z: lerp(from.origin.z, to.origin.z, f) };
      templates = { ...templates, [to.id]: { ...to, origin } };
    }
    out.push({ ...after, tokens: placed, templates });
  }
  out.push(after);
  return out;
}

/**
 * After an op reduces: the creature whose turn `encounter.next` started, in
 * the areas that hit then, and, during a turn, every creature an op brought
 * into an area that hits on entering, on the way or where it ends.
 */
export function remindAfter(tx: Tx, before: RoomState, op: Op): void {
  if (startedTurn(tx)) remindAtTurn(tx, "turnStart");
  if (op.t === "encounter.next") return;
  if (op.t !== "token.move" && op.t !== "token.moveMany" && op.t !== "token.update" && op.t !== "template.update") return;
  const after = tx.state;
  if (!inTurn(after)) return;
  const moved = movedBy(op, before, after);
  if (moved.tokens.size === 0 && moved.templateId === null) return;
  let swept: RoomState[] | null = null;
  for (const template of Object.values(after.templates).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!(template.triggers?.includes("enter") ?? false)) continue;
    // An area that moved, itself or with the token it follows or surrounds, can come onto anyone on its scene.
    const areaMoved =
      moved.templateId === template.id ||
      (template.attachedTo !== undefined && moved.tokens.has(template.attachedTo)) ||
      (template.casterId !== undefined && moved.tokens.has(template.casterId));
    const candidates = Object.values(after.tokens)
      .filter((t) => t.sceneId === template.sceneId && (areaMoved || moved.tokens.has(t.id)) && isCreature(after, t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (candidates.length === 0) continue;
    const was = before.templates[template.id];
    const earlier = was ? inside(before, was, candidates.map((t) => before.tokens[t.id]).filter((t): t is Token => t !== undefined)) : new Set<string>();
    let outside = candidates.filter((t) => !earlier.has(t.id));
    // Each creature that entered, with the room at the point of the leg where it did.
    const entered = new Map<string, RoomState>();
    const leg = outside.length > 0 ? (swept ??= alongLeg(before, after, moved)) : [];
    for (const at of leg) {
      const area = at.templates[template.id];
      if (!area) continue;
      for (const id of inside(at, area, outside.map((t) => at.tokens[t.id]!))) entered.set(id, at);
      outside = outside.filter((t) => !entered.has(t.id));
      if (outside.length === 0) break;
    }
    for (const token of candidates) {
      const at = entered.get(token.id);
      if (at) remind(tx, template, token, "enter", !moved.tokens.has(token.id), at === after ? tx.state : at);
    }
  }
}
