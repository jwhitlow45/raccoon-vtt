import { doorChunk, wallChunk } from "#shared/keys.ts";
import { serializedBytes } from "#shared/limits.ts";
import { CHUNK_CELLS, type BuildChunk, type JournalPage, type Light, type Pin, type RoomState, type Stamp, type Token, type Trap, type TrapRig, type TrapZone } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import { ASK_LOST, clientOpSchema, MAX_ASK_BYTES, MAX_ASK_OPS, MAX_ASK_PARTS, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { JOIN_CHANGED, joinChanged, WING_MOVED, wingClash, type WingClear } from "#shared/rules/wingClear.ts";
import type { OnAnswer, OpAnswer, OpRefusal, RoomActions, UnknownCause } from "../../state/types.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { addAnswer, CHECK_MS, movedOn, NO_ANSWERS, sceneShown, type Answers } from "../uvtt/rules.ts";
import { keyTitle } from "./keyPage.ts";

/*
 * Make the scene (docs/design/design-v1-dungeon-generator.md 4.4 and 5.5):
 * every op in one task and one Setup group, and the outcome the import's
 * mirrors (uvtt/rules.ts `importOutcome`, D-261102-388). A lost answer can
 * hide a refusal, so when answers are lost the scene the server stored is
 * compared with the scratch room the preview was drawn from.
 */

export type DungeonOutcome = { k: "complete"; checked: boolean } | { k: "none"; lost: boolean } | { k: "partial" } | { k: "unconfirmed" };

/**
 * The room the send reads beside its actions: the view, which holds the new
 * scene's contents only once it shows that scene, and whether the dialog is
 * on screen. A hidden dialog whose DM went to another scene has moved on,
 * so the new scene does not pull them away.
 */
export type SendRoom = { store: Pick<RoomViewStore, "getState" | "subscribe">; shown: () => boolean; checkMs?: number };

/**
 * A dungeon made as a floor (docs/design/design-v1-floors.md phase 3, 3.7,
 * D-261110-113): its key page and pins wait for the create, so a refused
 * floor leaves no page behind, and the page takes its title from the name
 * the server stored, which the reducer numbers while taken.
 */
export type SendFloor = {
  /** The key page's name for the floor's stored name: "Tower · Crypt 2" (words.ts `floorKeyName`). */
  keyName(floorName: string): string;
  /** The name the add sent, read until the floor's record shows. */
  sentName: string;
  /** Told once the create is answered, or refused at input: until then no close may let another op of this device into the group. */
  onCreated?(answer: OpAnswer): void;
};

/** A key page's ops: its page and the pins that link it (keyPage.ts `keyOps`). A dungeon writes no other page or pin. */
export function isKeyOp(op: ClientOp): boolean {
  return op.t === "journal.create" || op.t === "pin.put";
}

/**
 * Resolves true once the view holds the scene's record, or false when the
 * room ends or `ms` pass. A DM's view lists every scene, so a floor whose
 * create's answer was lost shows here once a reconnect brings it back.
 */
export function sceneListed(store: SendRoom["store"], sceneId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (listed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(listed);
    };
    const check = (s: ReturnType<SendRoom["store"]["getState"]>) => {
      if (s.view?.scenes[sceneId] !== undefined) finish(true);
      else if (s.ended) finish(false);
    };
    const timer = setTimeout(() => finish(false), ms);
    const unsubscribe = store.subscribe(check);
    check(store.getState());
  });
}

type Of<T> = Readonly<Record<string, T | undefined>>;
type Contents = Pick<RoomState, "buildChunks"> & {
  traps: Of<Pick<Trap, "sceneId" | "zone" | "state" | "rig">>;
  stamps?: Of<Pick<Stamp, "sceneId" | "art" | "x" | "y" | "w" | "h" | "rotation">>;
  lights?: Of<Pick<Light, "sceneId" | "x" | "y" | "bright" | "dim">>;
  tokens?: Of<Pick<Token, "id" | "sceneId" | "kind" | "name" | "x" | "y" | "visibility">>;
  pins?: Of<Pick<Pin, "sceneId" | "x" | "y" | "label" | "pageId" | "visibility">>;
  journal?: Of<Pick<JournalPage, "title" | "folder" | "access" | "blocks">>;
};

/**
 * How the contents name an id that something else names: a stored room's
 * as it holds it, and the scratch room's placeholders as Make made them
 * fresh (ops.ts `withIds`). One the map does not hold names nothing Make
 * made, so it never matches a stored id.
 */
export type IdOf = (id: string) => string;
const AS_STORED: IdOf = (id) => id;

/** The ids Make gave the scratch room's placeholders, as the contents read them. */
export function madeIds(ids: ReadonlyMap<string, string> | undefined): IdOf {
  return (id) => ids?.get(id) ?? `not made: ${id}`;
}

function sorted(items: Iterable<unknown>): string[] {
  return [...items].map((x) => stableStringify(x)).sort();
}

/**
 * A scene as the outcome compares it: each chunk's cells, edges, heights
 * and stairs by its place, its traps by zone, state and rig, its stamps by
 * art, place, size and turn, its lights by place and radii, its tokens by
 * kind, name, place and visibility, its pins by place, label and
 * visibility, and the journal pages its pins link by title, folder, access
 * and block texts. Revs, walls versions, ids and order are left out, since
 * each grows from its prior value or is fresh at Make. A reference is
 * compared by what it names, through `idOf` (phase 2, section 6): a trap's
 * show action by its token's id, which the token's own entry carries, and
 * a pin's page by its id. So a wrong target never matches, and an older
 * key page of the same title, which Delete leaves, is never taken for the
 * one this send made.
 */
export function sceneContents(state: Contents, sceneId: string, idOf: IdOf = AS_STORED): string {
  return contentsOf(state, sceneId, idOf, null);
}

/**
 * A chunk as the outcome compares it: its cells, edges, heights, stairs and
 * difficult ground, and its free walls by their ends and feature, sorted,
 * without ids, which are fresh at Make (phase 3, 3.5).
 */
function chunkContents(c: BuildChunk): unknown {
  const walls = c.walls && c.walls.length > 0 ? sorted(c.walls.map((w) => ({ a: w.a, b: w.b, f: w.f }))) : undefined;
  return { cells: c.cells, edges: c.edges, heights: c.heights, up: c.up, rough: c.rough, walls };
}

/** A trap's zone with a hex door's leaf named through `idOf`, as Make named it (phase 3, 3.5). */
function zoneNamed(zone: TrapZone, idOf: IdOf): TrapZone {
  return "door" in zone && "id" in zone.door ? { door: { ...zone.door, id: idOf(zone.door.id) } } : zone;
}

/**
 * The contents compared: a whole scene with `only` null, else a wing's
 * part of it, the chunks at `only.chunks` and the entities `only.made`
 * names, so what other members changed elsewhere on the scene, a token
 * walking past among it, never counts.
 */
function contentsOf(state: Contents, sceneId: string, idOf: IdOf, only: { chunks: ReadonlySet<string>; made: (id: string) => boolean } | null): string {
  const chunks: [string, unknown][] = [];
  for (const c of Object.values(state.buildChunks)) {
    if (c.sceneId !== sceneId) continue;
    const at = `${c.cx},${c.cy}`;
    if (!only || only.chunks.has(at)) chunks.push([at, chunkContents(c)]);
  }
  chunks.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const on = <T extends { sceneId: string }>(r: Of<T> | undefined): T[] =>
    Object.entries(r ?? {}).flatMap(([id, x]) => (x?.sceneId === sceneId && (!only || only.made(id)) ? [x] : []));
  const named = (rig: TrapRig | undefined): TrapRig | undefined =>
    rig && { ...rig, actions: rig.actions.map((a) => ("show" in a && "tokenId" in a.show ? { show: { tokenId: idOf(a.show.tokenId) } } : a)) };
  const traps = sorted(on(state.traps).map((t) => ({ zone: zoneNamed(t.zone, idOf), state: t.state, rig: named(t.rig) })));
  const stamps = sorted(on(state.stamps).map((s) => ({ art: s.art, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation })));
  const lights = sorted(on(state.lights).map((l) => ({ x: l.x, y: l.y, bright: l.bright, dim: l.dim })));
  // A wing's stones are compared without their place, since one may have rolled since (3.5: moved tokens never count).
  const tokens = sorted(on(state.tokens).map((t) => ({ id: idOf(t.id), kind: t.kind, name: t.name, visibility: t.visibility, ...(only ? {} : { x: t.x, y: t.y }) })));
  const pins = on(state.pins);
  const pages = sorted(
    [...new Set(pins.flatMap((p) => (p.pageId !== undefined ? [p.pageId] : [])))].map((id) => {
      const page = state.journal?.[id];
      return { id: idOf(id), page: page ? { title: page.title, folder: page.folder, access: page.access, blocks: page.blocks.map((b) => b.text) } : null };
    }),
  );
  const pinned = sorted(pins.map((p) => ({ x: p.x, y: p.y, label: p.label, visibility: p.visibility, page: p.pageId === undefined ? null : idOf(p.pageId) })));
  return stableStringify({ chunks, traps, stamps, lights, tokens, pins: pinned, pages });
}

/** The chunks a wing's ops write, as "cx,cy": each cell's, each edge's and each free wall's. */
export function wingChunks(ops: readonly ClientOp[]): Set<string> {
  const out = new Set<string>();
  const cell = (key: string) => {
    const [x, y] = key.split(",").map(Number) as [number, number];
    out.add(`${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`);
  };
  for (const op of ops) {
    if (op.t === "build.paint" || op.t === "build.height" || op.t === "build.stairs" || op.t === "build.rough") op.cells.forEach(cell);
    else if (op.t === "build.edge") {
      for (const e of op.edges) {
        const c = doorChunk({ edge: e.key });
        out.add(`${c.cx},${c.cy}`);
      }
    } else if (op.t === "build.walls") {
      for (const w of op.put ?? []) {
        const c = wallChunk(w);
        out.add(`${c.cx},${c.cy}`);
      }
      for (const r of op.remove ?? []) out.add(`${r.cx},${r.cy}`);
    }
  }
  return out;
}

/**
 * A wing as the outcome compares it (3.5): the chunks its ops write and
 * the entities it made, in the stored room by the ids Make gave them, and
 * in the scratch room by the placeholders `ids` maps.
 */
export function wingContents(state: Contents, sceneId: string, ops: readonly ClientOp[], ids: ReadonlyMap<string, string>, stored: boolean): string {
  const fresh = new Set(ids.values());
  const made = stored ? (id: string) => fresh.has(id) : (id: string) => ids.has(id);
  return contentsOf(state, sceneId, stored ? AS_STORED : madeIds(ids), { chunks: wingChunks(ops), made });
}

/** How it ended, from the answers and the room after: the import's rule, with the contents compared whole. */
export function dungeonOutcome(answers: Answers, created: OpAnswer, room: { exists: boolean; same: boolean | null }): DungeonOutcome {
  if (answers.refused === 0 && answers.unknown === 0) return { k: "complete", checked: false };
  if (created === "refused" || !room.exists) return { k: "none", lost: created !== "refused" && answers.unknown > 0 };
  if (answers.refused > 0) return { k: "partial" };
  return room.same === true ? { k: "complete", checked: true } : { k: "unconfirmed" };
}

/**
 * Parses a preview's ops once it lands, in a task of its own, so Make's
 * press finds zod's checks for each kind of op already built and run: the
 * first parse of a kind builds them, and the store parses every op again as
 * it queues it, all in the press's one task (D-261107-263). What it answers
 * is dropped.
 */
export function warmOpChecks(ops: readonly ClientOp[], parse: (op: ClientOp) => unknown = (op) => clientOpSchema.safeParse(op)): void {
  for (const op of ops) parse(op);
}

/**
 * Sends the dungeon and says how it ended. Every op is dispatched in this
 * one task, in one group under Setup, so no other op of this device falls
 * inside the group and a DM who switches apps mid-send leaves nothing half
 * queued, and all but the scene in one dispatch where the store offers it.
 * An op the store refuses at input (null, as while a builder gesture waits
 * on its ask) counts as refused, and when the scene itself is refused so,
 * nothing after it is sent. `onAnswered` hears each
 * answer as it comes. The scene opens once complete, or to be compared
 * when answers were lost, unless a hidden dialog's DM moved on. `ids` is
 * `withIds`' map, which the comparison follows references through:
 * without it a dungeon whose stones or pins name another of its ids is
 * never confirmed after a lost answer.
 *
 * As a floor (`floor`), the key page and its pins go once the create is
 * answered taken, or, its answer lost, once the floor's record shows, in the
 * same group and titled from the stored name. The dialog holds every close
 * until the create is answered, so no op of this device falls between, and
 * the key joins the floor's one Undo setup step. A refused create sends no
 * key, and a floor that does not show within the check's time sends none.
 * Still missing when the send ends, it reads as no floor added, as a new
 * scene does (D-261110-410). There by then, it is unconfirmed, since its key
 * page was never sent (D-261110-411).
 */
export async function sendDungeon(
  made: { ops: ClientOp[]; sceneId: string; room: RoomState; ids?: ReadonlyMap<string, string> },
  actions: RoomActions,
  onAnswered: (n: number, of: number) => void,
  room: SendRoom,
  floor?: SendFloor,
): Promise<DungeonOutcome> {
  const { store } = room;
  const total = made.ops.length;
  const startScene = store.getState().sceneId;
  const group = actions.newId();
  const checkMs = room.checkMs ?? CHECK_MS;
  let answers = NO_ANSWERS;
  // Set by the scene's own answer, inside the callbacks, so it is typed wide rather than narrowed to its start.
  let created = "unknown" as OpAnswer;
  /** The key's title as sent, which the lost-answer comparison reads in place of the preview's. */
  let sentTitle: string | null = null;
  /** The floor never showed in time after a lost answer, so its key was never sent. */
  let keyHeld = false;
  await new Promise<void>((resolve) => {
    let answered = 0;
    const settle = (i: number) => {
      let once = false;
      return (answer: OpAnswer) => {
        if (once) return;
        once = true;
        if (i === 0) created = answer;
        answers = addAnswer(answers, answer);
        answered++;
        onAnswered(answered, total);
        if (answered === total) resolve();
      };
    };
    const answer = made.ops.map((_, i) => settle(i));
    const opts = (i: number) => ({ group, groupScope: "setup" as const, onAnswer: answer[i]! });
    const [create, ...ops] = made.ops;
    if (create === undefined) return resolve();
    const later = floor ? ops.flatMap((op, k) => (isKeyOp(op) ? [k + 1] : [])) : [];
    const rest = ops.flatMap((op, k) => (later.includes(k + 1) ? [] : [{ op, i: k + 1 }]));
    /** Dispatches ops by index, in one view rebuild where the store offers it, since one rebuild per op costs the square of the count (D-261107-263). */
    const send = (list: readonly { op: ClientOp; i: number }[]) => {
      const ns = actions.dispatchMany ? actions.dispatchMany(list.map(({ op, i }) => ({ op, opts: opts(i) }))) : list.map(({ op, i }) => actions.dispatch(op, opts(i)));
      for (const [k, n] of ns.entries()) if (n === null) answer[list[k]!.i]!("refused");
    };
    /** The key page, titled from the floor's stored name, and its pins. */
    const sendKey = () => {
      const stored = store.getState().view?.scenes[made.sceneId]?.floor?.name ?? floor!.sentName;
      sentTitle = keyTitle(floor!.keyName(stored));
      send(later.map((i) => {
        const op = made.ops[i]!;
        return { op: op.t === "journal.create" ? { ...op, page: { ...op.page, title: sentTitle! } } : op, i };
      }));
    };
    const settleLater = (answer_: OpAnswer) => {
      for (const i of later) answer[i]!(answer_);
    };
    const createOpts = floor
      ? {
          ...opts(0),
          onAnswer: (a: OpAnswer) => {
            answer[0]!(a);
            floor.onCreated?.(a);
            if (later.length === 0) return;
            // Out of the store's answer, so the key's dispatch never runs inside the store's own handling of a reply.
            if (a === "taken") queueMicrotask(sendKey);
            else if (a === "refused") settleLater("refused");
            else
              void sceneListed(store, made.sceneId, checkMs).then((listed) => {
                if (listed) sendKey();
                else {
                  keyHeld = true;
                  settleLater("unknown");
                }
              });
          },
        }
      : opts(0);
    // The scene alone first: refused at input, nothing after it is sent.
    if (actions.dispatch(create, createOpts) === null) {
      floor?.onCreated?.("refused");
      for (const a of answer) a("refused");
      return;
    }
    send(rest);
  });

  const sceneId = made.sceneId;
  const exists = () => store.getState().view?.scenes[sceneId] !== undefined;
  const mayOpen = () => room.shown() || !movedOn(startScene, store.getState(), sceneId);
  let same: boolean | null = null;
  if (!keyHeld && created !== "refused" && answers.refused === 0 && answers.unknown > 0 && exists() && mayOpen()) {
    actions.switchScene(sceneId);
    if (await sceneShown(store, sceneId, checkMs)) {
      const view = store.getState().view;
      const scratchScene = Object.keys(made.room.scenes)[0] ?? "";
      same = view !== null && sceneContents(view, sceneId) === sceneContents(titled(made.room, sentTitle), scratchScene, madeIds(made.ids));
    }
  }
  // A floor whose key waited past the check and never showed reads as no floor added, as a new scene does (D-261110-410).
  const outcome: DungeonOutcome = keyHeld && exists() ? { k: "unconfirmed" } : dungeonOutcome(answers, created, { exists: exists(), same });
  if (outcome.k === "complete" && !outcome.checked && mayOpen()) actions.switchScene(sceneId);
  return outcome;
}

/** The scratch room with its key page under the title the send gave it, so the comparison reads the page the server holds. */
function titled(room: RoomState, title: string | null): RoomState {
  if (title === null) return room;
  return { ...room, journal: Object.fromEntries(Object.entries(room.journal).map(([id, page]) => [id, page && { ...page, title }])) };
}

/*
 * Add a wing (docs/design: dungeon generator phase 3, 3.5 and 3.6). A wing
 * lands on a scene players may remember, so it always asks first: its map
 * ops ride `build.ask`s carrying its clear, which the server checks against
 * the room as each part comes, and the send goes once every part is taken.
 */

/** A wing's end beside a dungeon's: its join changed, something moved into its footprint, or its asks were too many to send. */
export type WingOutcome = DungeonOutcome | { k: "join" } | { k: "moved" } | { k: "large" };

/** The line for a wing too large for its asks (3.5). */
export const WING_TOO_LARGE = "This wing is too large to check against players' remembered map. Pick fewer rooms.";

/** The ops a wing's asks carry: the builder's own and a wing's free walls and stamps (phase 3, 5). */
export const WING_ASKS: ReadonlySet<ClientOp["t"]> = new Set<ClientOp["t"]>(["build.paint", "build.erase", "build.rect", "build.edge", "build.height", "build.stairs", "build.rough", "build.walls", "build.stamps"]);

type Askable = OpOf<"build.ask">["ops"][number];

/** A wing's map ops in the shape an ask carries them: on the scene, without a yes. */
function asked(sceneId: string, ops: readonly ClientOp[]): Askable[] {
  return ops.flatMap((op) => {
    if (!WING_ASKS.has(op.t) || (op as { sceneId?: string }).sceneId !== sceneId) return [];
    const { forget: _yes, ...bare } = op as Askable;
    return [bare as Askable];
  });
}

/**
 * A wing's asks (3.6): its map ops packed in order into asks of at most
 * MAX_ASK_OPS ops and MAX_ASK_BYTES, each carrying the clear, numbered by
 * `part` and all but the last marked `more`. The smallest op goes last,
 * alone in its part, with the floor runs, so no part passes the bytes (I8).
 * Null when they take more than MAX_ASK_PARTS asks, or a part cannot fit.
 */
export function wingAsks(sceneId: string, ops: readonly ClientOp[], clear: WingClear): OpOf<"build.ask">[] | null {
  const all = asked(sceneId, ops);
  if (all.length === 0) return [];
  const { floor: _runs, ...bare } = clear;
  let smallest = 0;
  all.forEach((op, i) => {
    if (serializedBytes(op) < serializedBytes(all[smallest]!)) smallest = i;
  });
  const wrap = (part: Askable[], last: boolean): OpOf<"build.ask"> => ({ t: "build.ask", sceneId, ops: part, part: MAX_ASK_PARTS - 1, ...(last ? {} : { more: true as const }), clear: last ? clear : bare });
  const parts: Askable[][] = [];
  for (const [i, op] of all.entries()) {
    if (i === smallest) continue;
    const part = parts.at(-1);
    if (part && part.length < MAX_ASK_OPS && serializedBytes(wrap([...part, op], false)) <= MAX_ASK_BYTES) part.push(op);
    else parts.push([op]);
  }
  parts.push([all[smallest]!]);
  if (parts.length > MAX_ASK_PARTS) return null;
  const asks = parts.map((part, i): OpOf<"build.ask"> => {
    const last = i === parts.length - 1;
    return { t: "build.ask", sceneId, ops: part, part: i, ...(last ? {} : { more: true as const }), clear: last ? clear : bare };
  });
  return asks.every((a) => serializedBytes(a) <= MAX_ASK_BYTES) ? asks : null;
}

type Heard = { answer: OpAnswer; refusal?: OpRefusal; unknown?: UnknownCause };

/** What a wing's asks came to, the first refusal deciding (3.5): all taken, a forget question, a changed join or footprint, lost, or no. */
export function asksSettled(heard: readonly Heard[]): "taken" | "forget" | "join" | "moved" | "lost" | "none" {
  // A refused part drops the server's chain, so the parts after it are refused as lost: only the first refusal counts.
  const first = heard.find((h) => h.answer === "refused" && h.refusal?.message !== ASK_LOST);
  if (first) {
    if (first.refusal?.code === "forget") return "forget";
    if (first.refusal?.code === "invalid" && first.refusal.message === JOIN_CHANGED) return "join";
    if (first.refusal?.code === "invalid" && first.refusal.message === WING_MOVED) return "moved";
    return "none";
  }
  if (heard.every((h) => h.answer === "taken")) return "taken";
  if (heard.some((h) => h.answer === "unknown" && h.unknown === "expired")) return "none";
  return "lost";
}

/**
 * Sends a planned wing behind its asks (3.5) and says how it ended.
 *
 * First the device runs the server's two checks on the room as it stands:
 * a changed join ends as `join` and a clash as `moved`, so the pane clears
 * the join or plans again. Then the asks, under the wing's group, with the
 * builder held so no other edit overtakes it and Undo cancels it. A
 * refused `forget` asks the DM (`ask`), whose yes sends every op with the
 * yes. Asks lost before any refusal go again once.
 *
 * The send, in one task under Setup: the first map op alone, and nothing
 * after it if it is refused at input, then the other map ops, traps,
 * stamps, lights and stones by `dispatchMany`. Once each of those is
 * answered taken, the key's page and its pins go in the same group, so a
 * failed wing never leaves a key naming what is not there. `onAnswered`
 * hears (0, of) as the send starts, then each answer, so the pane says it
 * is checking until the first call. Every op is quiet: the pane says the
 * outcome.
 */
export async function sendWing(
  made: { ops: ClientOp[]; ids: ReadonlyMap<string, string>; room: RoomState; sceneId: string; clear: WingClear },
  actions: RoomActions,
  room: SendRoom,
  onAnswered: (n: number, of: number) => void,
  ask: (q: "forget") => Promise<boolean>,
): Promise<WingOutcome> {
  const { store } = room;
  const { sceneId, clear } = made;
  const live = store.getState().view;
  if (!live || joinChanged(live, sceneId, clear)) return { k: "join" };
  if (wingClash(live, sceneId, asked(sceneId, made.ops), clear) !== null) return { k: "moved" };
  const asks = wingAsks(sceneId, made.ops, clear);
  if (asks === null) return { k: "large" };

  let cancelled = false;
  let wake: (() => void) | null = null;
  const release = actions.holdBuild?.(() => {
    cancelled = true;
    wake?.();
  }) ?? (() => undefined);
  let group = actions.newId();
  let settled: ReturnType<typeof asksSettled> = "lost";
  try {
    for (let round = 0; round < 2 && settled === "lost"; round++) {
      if (round > 0) group = actions.newId();
      const heard: Heard[] = [];
      await new Promise<void>((resolve) => {
        wake = resolve;
        let left = asks.length;
        const hear = (h: Heard) => {
          heard.push(h);
          if (--left === 0) resolve();
        };
        for (const a of asks) {
          const onAnswer: OnAnswer = (answer, refusal, unknown) => hear({ answer, ...(refusal ? { refusal } : {}), ...(unknown ? { unknown } : {}) });
          if (actions.dispatch(a, { group, groupScope: "setup", quiet: true, onAnswer }) === null) hear({ answer: "refused" });
        }
      });
      wake = null;
      if (cancelled) return { k: "none", lost: false };
      settled = asksSettled(heard);
    }
  } finally {
    release();
  }
  if (settled === "join") return { k: "join" };
  if (settled === "moved") return { k: "moved" };
  if (settled === "lost") return { k: "none", lost: true };
  if (settled === "none") return { k: "none", lost: false };
  const forget = settled === "forget";
  if (forget && !(await ask("forget"))) return { k: "none", lost: false };
  return sendWingOps(made, actions, room, group, forget, onAnswered);
}

/** The wing's ops once its asks are answered (3.5), and the outcome compared with the scratch room where answers were lost. */
async function sendWingOps(
  made: { ops: ClientOp[]; ids: ReadonlyMap<string, string>; room: RoomState; sceneId: string },
  actions: RoomActions,
  room: SendRoom,
  group: string,
  forget: boolean,
  onAnswered: (n: number, of: number) => void,
): Promise<WingOutcome> {
  const yes = (op: ClientOp): ClientOp => (forget && WING_ASKS.has(op.t) ? ({ ...op, forget: true } as ClientOp) : op);
  const keyed = made.ops.flatMap((op, i) => (isKeyOp(op) ? [i] : []));
  const body = made.ops.flatMap((op, i) => (isKeyOp(op) ? [] : [i]));
  const total = made.ops.length;
  let answers = NO_ANSWERS;
  let first = "unknown" as OpAnswer;
  let keySent = false;
  onAnswered(0, total);
  await new Promise<void>((resolve) => {
    let answered = 0;
    let bodyLeft = body.length;
    let bodyTaken = true;
    const once = new Set<number>();
    const opts = (i: number): { group: string; groupScope: "setup"; onAnswer: OnAnswer; quiet: boolean } => ({ group, groupScope: "setup", quiet: true, onAnswer: (a) => hear(i, a) });
    const sendKey = () => {
      keySent = true;
      const ns = actions.dispatchMany ? actions.dispatchMany(keyed.map((i) => ({ op: made.ops[i]!, opts: opts(i) }))) : keyed.map((i) => actions.dispatch(made.ops[i]!, opts(i)));
      ns.forEach((n, k) => {
        if (n === null) hear(keyed[k]!, "refused");
      });
    };
    const hear = (i: number, a: OpAnswer) => {
      if (once.has(i)) return;
      once.add(i);
      if (i === body[0]) first = a;
      answers = addAnswer(answers, a);
      answered++;
      onAnswered(answered, total);
      if (!keyed.includes(i)) {
        if (a !== "taken") bodyTaken = false;
        if (--bodyLeft === 0) {
          // The page and its pins only once all the rest is taken: otherwise they stay unsent (3.5, D-261110-174).
          if (bodyTaken && keyed.length > 0) queueMicrotask(sendKey);
          else resolve();
          return;
        }
      }
      if (answered === (keySent ? total : body.length)) resolve();
    };
    const [lead, ...rest] = body;
    if (lead === undefined) return resolve();
    if (actions.dispatch(yes(made.ops[lead]!), opts(lead)) === null) {
      // Refused at input, nothing after it goes.
      first = "refused";
      answers = addAnswer(answers, "refused");
      return resolve();
    }
    const ns = actions.dispatchMany ? actions.dispatchMany(rest.map((i) => ({ op: yes(made.ops[i]!), opts: opts(i) }))) : rest.map((i) => actions.dispatch(yes(made.ops[i]!), opts(i)));
    ns.forEach((n, k) => {
      if (n === null) hear(rest[k]!, "refused");
    });
  });
  if (first === "refused") return { k: "none", lost: false };
  if (answers.refused > 0) return { k: "partial" };
  if (answers.unknown === 0) return { k: "complete", checked: false };
  // Lost answers: the wing's part of the scene the server holds against the scratch room's, without the key where it never went.
  const { store } = room;
  if (store.getState().sceneId !== made.sceneId || !(await sceneShown(store, made.sceneId, room.checkMs ?? CHECK_MS))) return { k: "unconfirmed" };
  const view = store.getState().view;
  const sent = keySent ? made.ops : made.ops.filter((op) => !isKeyOp(op));
  const scratch = keySent ? made.room : withoutKey(made.room, made.ops, made.ids);
  const same = view !== null && wingContents(view, made.sceneId, sent, made.ids, true) === wingContents(scratch, made.sceneId, sent, made.ids, false);
  return same ? { k: "complete", checked: true } : { k: "unconfirmed" };
}

/** The scratch room without the key's page and pins, for a comparison where they were never sent. Its ids are placeholders, which `ids` maps to the ops' fresh ones. */
function withoutKey(room: RoomState, ops: readonly ClientOp[], ids: ReadonlyMap<string, string>): RoomState {
  const sent = new Set(ops.flatMap((op) => (op.t === "journal.create" ? [op.page.id] : op.t === "pin.put" ? [op.pin.id] : [])));
  const kept = <T>(r: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(r).filter(([id]) => !sent.has(ids.get(id) ?? id)));
  return { ...room, journal: kept(room.journal), pins: kept(room.pins) };
}
