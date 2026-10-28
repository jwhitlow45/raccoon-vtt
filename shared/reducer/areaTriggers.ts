import { attaches, discoversMap, logsByAudience, trapsGoOff, walksRoutes } from "../migrate.ts";
import type { AreaTemplate, AreaTrigger, LogEntry, LogEvent, RoomState, Token } from "../model.ts";
import { areaSeenMark, gridOfScene, inSightOfNonOwners, seenByNonOwners } from "../project.ts";
import { MAX_NAME, type Op } from "../protocol.ts";
import { convexHull, creaturesInArea, resolveArea, type AreaContext, type AreaTemplateInput, type AreaToken, type ResolvedArea } from "../rules/aoe.ts";
import { walkerFor } from "../rules/attach.ts";
import { describeMove, type MovedToken } from "../rules/moveLeg.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, type Hex, type HexGrid } from "../rules/hex.ts";
import { hexPiece, pieceReach, placedOnTrace, routePoints, type HexPiece, type RoutePoint } from "../rules/route.ts";
import { footprintRect, occupiedHexes, occupiedRange, type PlacedToken } from "../rules/footprint.ts";
import type { Point, Rect } from "../rules/geom.ts";
import { convexLive, fogClassOf, pendingGround } from "../rules/held.ts";
import { sceneWalls } from "../rules/walls.ts";
import type { Tx } from "./tx.ts";
import { isHex, sceneGrid, type Grid } from "../rules/grid.ts";

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
 * about a creature once a turn. Since op version 19 the room keeps which
 * reminders each audience read this turn (reminded.ts), and a turn runs
 * from Next, the removal of the acting row or Previous. Ops stored before
 * then read the log back to its newest `turn` line, as they did.
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
    grid: sceneGrid(scene),
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
 * Whether the log already reminded about this creature and area since its
 * newest turn line, for any trigger when the area hits once a turn, else
 * for this one: the rule of ops stored before op version 19, which kept
 * every line in one ring in order. Later ops keep a record instead
 * (Tx.addReminder, reminded.ts).
 */
function remindedInLog(log: readonly LogEntry[], template: AreaTemplate, tokenId: string, trigger: AreaTrigger): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const data = log[i]!.data;
    if (data?.type === "turn") return false;
    if (data?.type === "area" && data.templateId === template.id && data.tokenId === tokenId && (template.oncePerTurn === true || data.trigger === trigger)) return true;
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
  const recorded = logsByAudience(tx.env.opVersion);
  if (!recorded && remindedInLog(tx.state.log, template, token.id, trigger)) return;
  const there = at.tokens[token.id] ?? token;
  const line: Extract<LogEvent, { type: "area" }> = {
    type: "area",
    templateId: template.id,
    tokenId: token.id,
    trigger,
    area: areaName(template),
    ...(areaMoved ? { moved: true as const } : {}),
    ...marksOf(tx, template, there, at),
  };
  if (recorded) tx.addReminder(line, template.oncePerTurn === true);
  else tx.addEvent(line);
}

/**
 * Who a reminder reaches by what players saw then (`at`): on a whole-party
 * scene the creature's `seen` mark, the area's own sight checked when the
 * line is read, and `hidden` for an area the DM hid or one on a token
 * players cannot see. On a per-player scene the players who saw both the
 * creature and the area (project.ts areaSeenMark,
 * docs/design-v1-per-player-vision.md 6.5).
 */
function marksOf(tx: Tx, template: AreaTemplate, there: Token, at: RoomState): { seen?: true; seenBy?: string[]; hidden?: true } {
  const rays = discoversMap(tx.env.opVersion) ? raysOnLiveGround(at, template, there) : null;
  const perPlayer = areaSeenMark(at, template, there, tx.env);
  if (perPlayer) {
    const { hidden, ...seen } = perPlayer;
    return { ...(rays ? byLiveGround(at, seen, rays) : seen), ...(hidden ? { hidden } : {}) };
  }
  const attached = template.attachedTo !== undefined ? at.tokens[template.attachedTo] : undefined;
  // On a whole-party scene every player reads the shared class's ground, so a ray off it keeps the line the DM's alone.
  const hidden = template.visibility === "dm" || (attached !== undefined && !seenByNonOwners(at, attached, tx.env)) || (rays !== null && !rays(null));
  return { ...(seenByNonOwners(at, there, tx.env) ? { seen: true as const } : {}), ...(hidden ? { hidden: true as const } : {}) };
}

/**
 * A per-player scene's witnesses kept only where the rays lie on each
 * one's own live ground (decision 13): `seen` stays only when every
 * player's does, and otherwise the players whose ground holds them, as a
 * line only some read (docs/design-v1-per-player-vision.md 6.5).
 */
function byLiveGround(at: RoomState, seen: { seen?: true; seenBy?: string[] }, rays: (holder: string | null) => boolean): { seen?: true; seenBy?: string[] } {
  const players = Object.values(at.members).flatMap((m) => (m.kind === "player" ? [m.id] : []));
  const witnesses = seen.seen ? players : seen.seenBy;
  if (witnesses === undefined) return seen;
  const kept = witnesses.filter((id) => rays(id)).sort();
  return seen.seen && rays(null) && kept.length === players.length ? { seen: true } : { seenBy: kept };
}

/**
 * Whether every ray an area's inclusion test reads, from where it starts
 * to the creature's footprint, lies on a player's live ground
 * (docs/design-v1-map-discovery.md decision 13): their sight or the DM's
 * reveals, or revealed ground on a scene with fog and no vision. Asked by
 * fog class, a holder's own or null for the shared one, and null on a
 * scene with fog off, where every ray does. The rays start at the area's
 * probes (aoe.ts resolveArea): its origin, the corners and middle of the
 * box an emanation surrounds, the centers of the hexes one surrounds, or
 * where an attached area leaves its token, each moved off the walls by up
 * to 1/64 cell per axis (segments.ts stepOffWalls) or nudged a millionth.
 * Each ends at a sample inside the cells or hexes the creature stands on.
 * So all of them lie in the hull of those starts grown by the step and the
 * creature's cells, and every cell of the scene's grid that hull touches
 * must be live (held.ts convexLive, the hull `rayHull`). So a player
 * never learns that an area reaches a creature through ground they do not
 * see now, where a remembered wall may be gone or an unseen one stand. The
 * ground is the pending one: what this op brought into sight is live
 * though the explore step after the batch has not yet written it
 * (MD2-O-3).
 */
function raysOnLiveGround(at: RoomState, template: AreaTemplate, there: Token): ((holder: string | null) => boolean) | null {
  const scene = at.scenes[template.sceneId];
  if (!scene?.fogEnabled) return null;
  const grid = sceneGrid(scene);
  const ctx = contextOf(at, template.sceneId);
  const area = ctx ? resolveArea(template, ctx) : null;
  const attached = template.attachedTo !== undefined ? at.tokens[template.attachedTo] : undefined;
  const hull = rayHull(grid, template, area, attached, there);
  const answers = new Map<string | null, boolean>();
  return (member) => {
    const holder = member === null ? null : fogClassOf(at, template.sceneId, member);
    if (!answers.has(holder)) {
      const ground = pendingGround(at, template.sceneId, holder);
      answers.set(holder, ground !== null && convexLive(ground, hull));
    }
    return answers.get(holder)!;
  };
}

/**
 * The hull every ray an area's inclusion reads to a creature lies in
 * (`raysOnLiveGround` says how), for the server's reminders and a player's
 * device's caught lists and rings alike (client/features/areas/coverage.ts),
 * so the two read one rule. `area` is the template resolved, `attached` the
 * token it starts from, if any.
 */
export function rayHull(grid: Grid, template: Pick<AreaTemplateInput, "origin" | "shape">, area: ResolvedArea | null, attached: PlacedToken | undefined, there: PlacedToken): Point[] {
  // An attached area starts from its token, wherever its stored origin lies (aoe.ts resolveArea), so that origin is no probe.
  const probes: Point[] = attached ? [...corners(footprintRect(grid, attached)), ...(isHex(grid) ? hexOutline(grid, occupiedHexes(grid, attached)) : [])] : [{ x: template.origin.x, y: template.origin.y }];
  if (area?.box) probes.push(...corners(area.box));
  // A point emanation on hexes looks from the center of the hex its origin is in.
  if (isHex(grid) && !attached && !area?.box && template.shape === "emanation") probes.push(hexCenter(grid, hexAt(grid, template.origin)));
  const starts = probes.flatMap((p) => corners({ x: p.x - PROBE_STEP, y: p.y - PROBE_STEP, w: 2 * PROBE_STEP, h: 2 * PROBE_STEP }));
  const r = occupiedRange(grid, there);
  const ends = isHex(grid) ? hexOutline(grid, occupiedHexes(grid, there)) : corners(inset({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }, SAMPLE_INSET));
  return convexHull([...starts, ...ends]);
}

/** How far a probe moves off the walls at most, per axis (segments.ts STEPS), past a millionth's nudge. */
const PROBE_STEP = 1 / 64;

/** How far inside the cells a creature stands on every sample of them lies, at least: half a sample at the most samples a cell side takes (aoe.ts SAMPLES), and a margin. */
const SAMPLE_INSET = 1 / 64;

function inset(r: Rect, d: number): Rect {
  const dx = Math.min(d, r.w / 2);
  const dy = Math.min(d, r.h / 2);
  return { x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy };
}

function corners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x, y: r.y + r.h },
    { x: r.x + r.w, y: r.y + r.h },
  ];
}

function hexOutline(grid: HexGrid, hexes: readonly Hex[]): Point[] {
  return hexes.flatMap((h) => hexCorners(grid, h).map((c) => cornerAt(grid, c)));
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
type Moved = { tokens: Set<string>; templateId: string | null; walks?: GroupWalks };

function movedBy(tx: Tx, op: Op, before: RoomState, after: RoomState): Moved {
  const tokens = new Set<string>();
  const templateId = op.t === "template.update" ? op.templateId : null;
  // From op version 14 a holder's group moves with it, and the move's one description names every token (docs/design-v1-attach.md 9).
  if (attaches(tx.env.opVersion)) {
    const described = describeMove(op, before, after, tx.actor, tx.env).filter((m) => placeChanged(before.tokens[m.tokenId], after.tokens[m.tokenId]));
    for (const m of described) tokens.add(m.tokenId);
    return { tokens, templateId, walks: { named: described.filter((m) => m.carriedBy === undefined), all: described } };
  }
  const ids =
    op.t === "token.move" ? [op.tokenId] : op.t === "token.moveMany" ? op.moves.map((m) => m.tokenId) : op.t === "token.update" ? [op.tokenId] : [];
  for (const id of ids) if (placeChanged(before.tokens[id], after.tokens[id])) tokens.add(id);
  return { tokens, templateId };
}

/** The walks of an op's moved tokens, the named ones apart: only they decide how finely the move is swept. */
type GroupWalks = { named: MovedToken[]; all: MovedToken[] };

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

/** A routed move's walk (docs/design-v1-movement.md 7.2): its token and its points, elevations by the walk's rule from the state before. */
type Walked = { tokenId: string; points: RoutePoint[] };

/**
 * The walk of a `token.move` that carries a route, since op version 13. An
 * op without one, and every older op, is a straight leg as before.
 */
function walkOf(before: RoomState, after: RoomState, op: Op, opVersion: number | undefined): Walked | null {
  if (op.t !== "token.move" || !op.route || !walksRoutes(opVersion)) return null;
  const from = before.tokens[op.tokenId];
  const to = after.tokens[op.tokenId];
  if (!from || !to || from.sceneId !== to.sceneId) return null;
  const seen = (t: { id: string }) => {
    const token = before.tokens[t.id];
    return token !== undefined && inSightOfNonOwners(before, token, { opVersion });
  };
  return { tokenId: op.tokenId, points: routePoints(before.buildChunks, walkerFor(before, from, seen, { opVersion, to }), op.route, to.elevation) };
}

/** A route's sweep never takes more than this: every half square of 300 squares of reach, and one more a piece for rounding (section 10). */
export const MAX_ROUTE_SWEEP = 664;

/**
 * How many points each piece of a route's sweep takes, the last its end:
 * `ceil(reach / 0.5)`, at least one, the straight leg's density. A player's
 * route under fog counts no climbs toward its cap (MD2-O-13), so steep
 * pieces can want more than MAX_ROUTE_SWEEP in all. Then every piece first
 * takes what its reach across the ground wants, as on flat ground, which
 * the cap was sized for, and only the rest of the cap is shared among the
 * climbs, in proportion to what each wanted past that. So a flat piece
 * after steep ones keeps its whole density, where sampling in order until
 * the cap ran out skipped it and sharing the whole cap thinned it past
 * catching an area. Should the ground alone want more than the cap, which
 * a route the cap accepts cannot, every piece takes one and the rest is
 * shared the same way.
 */
export function routeSweepPlan(points: readonly RoutePoint[], feetPerCell: number): number[] {
  const wanted: number[] = [];
  const across: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    wanted.push(Math.max(1, Math.ceil(pieceReach(a, b, feetPerCell) / SWEEP_STEP)));
    across.push(Math.max(1, Math.ceil(pieceReach(a, { ...b, elevation: a.elevation }, feetPerCell) / SWEEP_STEP)));
  }
  const sum = (ns: readonly number[]) => ns.reduce((total, n) => total + n, 0);
  if (sum(wanted) <= MAX_ROUTE_SWEEP) return wanted;
  const base = sum(across) <= MAX_ROUTE_SWEEP ? across : wanted.map(() => 1);
  const left = Math.max(0, MAX_ROUTE_SWEEP - sum(base));
  const extra = sum(wanted) - sum(base);
  return wanted.map((n, i) => base[i]! + Math.floor(((n - base[i]!) * left) / extra));
}

/**
 * The room along a routed walk, piece by piece at the straight leg's own
 * density (`routeSweepPlan`, elevation interpolated between its ends), so
 * a route never skips an area a straight leg of its length would catch,
 * ending with `after` itself. Only ops before version
 * 14 take it, and they replay with the footprint the move left: later ones
 * sweep their walks in `alongGroups`.
 */
function alongWalkBeforeV14(after: RoomState, walk: Walked): RoomState[] {
  const fpc = after.meta.settings.feetPerCell;
  const token = after.tokens[walk.tokenId]!;
  const out: RoomState[] = [];
  const { points } = walk;
  const plan = routeSweepPlan(points, fpc);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const n = plan[i - 1]!;
    for (let k = 1; k <= n; k++) {
      if (i === points.length - 1 && k === n) break;
      const f = k / n;
      const placed = { ...after.tokens, [token.id]: { ...token, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), elevation: lerp(a.elevation, b.elevation, f) } };
      out.push({ ...after, tokens: placed });
    }
  }
  out.push(after);
  return out;
}

/**
 * The room along an op's walks since op version 14 (docs/design-v1-attach.md
 * 9): every moved token, a holder's group included, at the same progress
 * along its own walk. How finely is decided by the tokens the op names
 * alone, as before groups, so a hidden passenger never changes where a
 * visible token is sampled: piece by piece at the straight leg's density for
 * a routed walk, and for straight legs by the longest named one. A carried
 * token stopped short of its holder's walk waits at its stop. Each token
 * stands with the footprint its walk's trace has at each point, as its
 * path's visibility reads it (route.ts onTrace): its own walk's, or the
 * one its holder takes it along by.
 *
 * On a hex scene a straight leg's reach is the larger of its hex steps,
 * between its ends' reference hexes, and its vertical steps, and each point
 * stands on the hex line's hex at its fraction, its elevation even between
 * the ends (docs/design-v1-hex-grids.md 4.4). So a creature rising through
 * a sphere on a steep diagonal enters it, and the sweep reads the same
 * hexes as the walk's spots.
 */
function alongGroups(after: RoomState, moved: Moved & { walks: GroupWalks }, routed: boolean): RoomState[] {
  const fpc = after.meta.settings.feetPerCell;
  const { named, all } = moved.walks;
  const gridOf = (walk: MovedToken) => gridOfScene(after, walk.to.sceneId);
  // A straight leg's hex line, built once a walk and read at its walker's size where the leg starts.
  const pieces = new Map<MovedToken, HexPiece>();
  const pieceOf = (g: HexGrid, walk: MovedToken): HexPiece => {
    let piece = pieces.get(walk);
    if (!piece) pieces.set(walk, (piece = hexPiece(g, walk.trace[0] ?? after.tokens[walk.tokenId]!, walk.route[0]!, walk.route[walk.route.length - 1]!)));
    return piece;
  };
  // The spot at progress `f` along piece `piece` (1 the first) of a walk, with which of its trace's walkers stands there.
  const at = (walk: MovedToken, piece: number, f: number): { spot: RoutePoint; piece: number; end: boolean } => {
    const points = walk.route;
    const g = gridOf(walk);
    if (!routed && g.shape === "hex") {
      const a = points[0]!;
      const b = points[points.length - 1]!;
      return { spot: { ...pieceOf(g, walk).at(f), elevation: lerp(a.elevation, b.elevation, f) }, piece: 0, end: f >= 1 };
    }
    if (!routed) return { spot: lerpPoint(points[0]!, points[points.length - 1]!, f), piece: 0, end: f >= 1 };
    if (piece >= points.length) return { spot: points[points.length - 1]!, piece: points.length - 2, end: true };
    return { spot: lerpPoint(points[piece - 1]!, points[piece]!, f), piece: piece - 1, end: f >= 1 };
  };
  const place = (piece: number, f: number): RoomState => {
    const placed = { ...after.tokens };
    for (const walk of all) {
      const token = after.tokens[walk.tokenId];
      if (!token || walk.from.sceneId !== walk.to.sceneId) continue;
      const p = at(walk, piece, f);
      placed[token.id] = placedOnTrace(walk.trace, p.piece, p.end, token, p.spot);
    }
    return { ...after, tokens: placed };
  };
  const out: RoomState[] = [];
  if (routed) {
    const lead = named[0]!.route;
    const plan = routeSweepPlan(lead, fpc);
    for (let i = 1; i < lead.length; i++) {
      const n = plan[i - 1]!;
      for (let k = 1; k <= n; k++) {
        if (i === lead.length - 1 && k === n) break;
        out.push(place(i, k / n));
      }
    }
  } else {
    let reach = 0;
    for (const walk of named) {
      if (walk.from.sceneId !== walk.to.sceneId) continue;
      const g = gridOf(walk);
      if (g.shape === "hex") {
        reach = Math.max(reach, pieceOf(g, walk).steps, Math.abs(walk.to.elevation - walk.from.elevation) / fpc);
      } else reach = Math.max(reach, pieceReach(walk.from, walk.to, fpc));
    }
    const points = Math.min(MAX_SWEEP_POINTS, Math.max(1, Math.ceil(reach / SWEEP_STEP)));
    for (let k = 1; k < points; k++) out.push(place(1, k / points));
  }
  out.push(after);
  return out;
}

/** A token at a spot of its leg as ops before version 14 replay it, which describe no walk: with the footprint the move left. */
function placedBeforeV14(to: Token, spot: RoutePoint): Token {
  return { ...to, ...spot };
}

function lerpPoint(a: RoutePoint, b: RoutePoint, f: number): RoutePoint {
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), elevation: lerp(a.elevation, b.elevation, f) };
}

/**
 * The room at each point along the op's leg after it began, ending with
 * `after` itself. From op version 14 each token stands there with the
 * footprint its walk's trace has on its leg (route.ts onTrace). Older ops,
 * which describe no walks, replay with the footprint the move left.
 */
function alongLeg(before: RoomState, after: RoomState, moved: Moved): RoomState[] {
  // Since op version 14 every moved token has its walk's trace, and each spot reads it. Older ops replay with the footprint the move left.
  const traces = moved.walks ? new Map(moved.walks.all.map((w) => [w.tokenId, w.trace])) : null;
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
    for (const [from, to] of tokens) {
      const spot = lerpPoint(from, to, f);
      placed[to.id] = traces ? placedOnTrace(traces.get(to.id)!, 0, false, to, spot) : placedBeforeV14(to, spot);
    }
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
 * The ops that can bring a creature into an area. Since op version 14 a
 * step onto a seat and a get-off leg are walks of the shared move
 * description too (docs/design-v1-attach.md 9), so they remind as a move does.
 */
function movesIntoAreas(op: Op, opVersion: number | undefined): boolean {
  if (op.t === "token.move" || op.t === "token.moveMany" || op.t === "token.update" || op.t === "template.update") return true;
  return (op.t === "token.attach" || op.t === "token.detach") && attaches(opVersion);
}

/**
 * After an op reduces: the creature whose turn `encounter.next` started, in
 * the areas that hit then, and, during a turn, every creature an op brought
 * into an area that hits on entering, on the way or where it ends.
 */
export function remindAfter(tx: Tx, before: RoomState, op: Op): void {
  if (startedTurn(tx)) remindAtTurn(tx, "turnStart");
  if (op.t === "encounter.next") return;
  if (!movesIntoAreas(op, tx.env.opVersion)) return;
  const after = tx.state;
  if (!inTurn(after)) return;
  const moved = movedBy(tx, op, before, after);
  if (moved.tokens.size === 0 && moved.templateId === null) return;
  const walk = moved.tokens.size > 0 && !moved.walks ? walkOf(before, after, op, tx.env.opVersion) : null;
  const grouped = moved.walks && moved.walks.named.length > 0 ? { ...moved, walks: moved.walks } : null;
  const routed = op.t === "token.move" && op.route !== undefined && walksRoutes(tx.env.opVersion);
  // A teleport enters an area only where it lands, as it sets off a trap only there (docs/design-v1-traps.md 6.6, 13.2). Ops stored
  // before op version 15 swept its straight leg, and replay so.
  const landsOnly = op.t === "token.move" && op.teleport !== undefined && trapsGoOff(tx.env.opVersion);
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
    const leg = outside.length > 0 ? (swept ??= landsOnly ? [after] : grouped ? alongGroups(after, grouped, routed) : walk ? alongWalkBeforeV14(after, walk) : alongLeg(before, after, moved)) : [];
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
