import { idTime } from "#shared/ids.ts";
import { SEALED_IDS_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog, projectState } from "#shared/project.ts";
import { playersToken } from "#shared/players.ts";
import { ownEntry } from "#shared/records.ts";
import { rekeySync } from "#shared/rules/pcSync.ts";
import { lineAccess, readerStreams, snapshotJson, storeSnapshot, type LoadedRoom, type Pool } from "./persistence.ts";

/**
 * New ids for a room's things at its first load on this build, once its
 * stored ops have replayed in full (SEALED_IDS_SNAPSHOT_VERSION).
 *
 * The ids kept are those some player can name: every id in a player's or
 * the table display's copy of the room, as a snapshot sends it (`held`),
 * and every id the room's records of a showing hold, or a log line some
 * player can read now, live or archived, projected for that player as
 * their log page does (`marked`). So are member ids, roll tags, plan and
 * page ids and the save ledger's keys, and the room's first scene, which
 * are found by where they sit. Every other version 7 id, in the state or
 * the archive, takes a new one from `newId`, written wherever the old one
 * stood, inside longer strings too, so each copy a player reads, and each
 * log page, is the same before and after.
 */

/** A version 7 id anywhere in a string, as UUIDs are written, in either case. */
const V7_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/** Every version 7 id in `text`, inside longer strings too, added to `into`. */
export function v7IdsIn(text: string, into: Set<string> = new Set()): Set<string> {
  for (const m of text.matchAll(V7_TEXT)) into.add(m[0]);
  return into;
}

/** Whether a room's load gives its ids anew: below the format, and only after a replay of every stored op. */
export function reidDue(loaded: Pick<LoadedRoom, "replayFailed" | "snapshotVersion">): boolean {
  return !loaded.replayFailed && loaded.snapshotVersion < SEALED_IDS_SNAPSHOT_VERSION;
}

/** A table display's viewer: a player that is no member, who reads what every player shares. */
const DISPLAY: Viewer = { memberId: "display:000000000000", role: "player" };

/** How long after its first member a room's first scene is made (shared/initial.ts): in the same request. */
const FIRST_SCENE_MS = 1_000;

/** A stored log line, and whether its access rows are complete (persistence.ts archiveLines). */
export type ArchivedLine = { entry: LogEntry; complete: boolean; text?: string };

/**
 * Which ids a room keeps and which it gives anew, built from the state and
 * then the archive, a batch of rows at a time.
 */
export class ReidPlan {
  readonly #state: RoomState;
  readonly #players: Viewer[];
  /** Every version 7 id the state or the archive holds. */
  readonly #found = new Set<string>();
  readonly #kept = new Set<string>();

  constructor(state: RoomState, memberIds: Iterable<string> = []) {
    this.#state = state;
    this.#players = Object.values(state.members).flatMap((m) => (m.kind === "player" ? [{ memberId: m.id, role: "player" as const }] : []));
    v7IdsIn(JSON.stringify(state), this.#found);
    for (const viewer of [...this.#players, DISPLAY]) v7IdsIn(JSON.stringify(projectState(state, viewer, { sceneId: null })), this.#kept);
    recordIds(state, this.#kept);
    keptByPlace(state, this.#kept);
    const members = new Set([...Object.keys(state.members), ...memberIds]);
    for (const id of members) this.#kept.add(id);
    const first = firstScene(state, members);
    if (first !== null) this.#kept.add(first);
    this.addLines(state.log.map((entry) => ({ entry, complete: true })));
  }

  /**
   * Reads stored lines: each one's ids, and the ids each player who may
   * read it reads in it. A line whose access rows are complete is read by
   * the players of its streams, one whose rows are not by every player.
   * Returns each line's version 7 ids, in order.
   */
  addLines(lines: readonly ArchivedLine[]): string[][] {
    const out = lines.map((line) => [...v7IdsIn(line.text ?? JSON.stringify(line.entry))]);
    for (const ids of out) for (const id of ids) this.#found.add(id);
    for (const line of lines) keptByPlace(line.entry, this.#kept);
    for (const viewer of this.#players) {
      const streams = readerStreams(viewer);
      const readable = lines.filter((line) => !line.complete || lineAccess(line.entry).some((a) => streams.some((s) => s.stream === a.stream && s.memberId === a.memberId)));
      if (readable.length === 0) continue;
      v7IdsIn(JSON.stringify(projectArchivedLog(this.#state, readable.map((line) => line.entry), viewer, { sceneId: null })), this.#kept);
    }
    return out;
  }

  /** Whether the room keeps `id`. */
  keeps(id: string): boolean {
    return this.#kept.has(id);
  }

  /** A new id for each version 7 id found that the room does not keep. */
  renames(newId: () => string): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of this.#found) if (!this.#kept.has(id)) out.set(id, newId());
    return out;
  }
}

/**
 * The ids the room's records of a showing hold: the scenes and floors
 * played, the creatures players met or saw on a path's stop, the creatures
 * a turn revealed with their rows and conditions then, what players
 * remember, the sprung traps they saw, and every handout.
 */
function recordIds(state: RoomState, into: Set<string>): void {
  v7IdsIn(JSON.stringify([state.playedScenes ?? {}, state.openFloors ?? {}, state.memory ?? {}, state.memoryBy ?? {}, state.trapSeen ?? [], state.handouts]), into);
  for (const token of Object.values(state.tokens)) {
    if (token.met !== undefined || token.path?.stops.some((stop) => stop.seen === true || (stop.seenBy?.length ?? 0) > 0)) into.add(token.id);
  }
  for (const step of state.encounterHistory) {
    for (const { tokenId } of step.revealed) {
      into.add(tokenId);
      for (const entry of step.encounter.entries) if (entry.tokenId === tokenId) into.add(entry.id);
      for (const effect of step.effects[tokenId] ?? []) into.add(effect.id);
    }
  }
}

/**
 * The ids kept by where they sit, at any depth of `value`: a roll's tag
 * (and the tag an ask to change it names), a plan id, and the save
 * ledger's keys.
 */
function keptByPlace(value: unknown, into: Set<string>): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (v === null || typeof v !== "object") continue;
    const record = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(record)) {
      if (typeof x === "string") {
        if (k === "tag" || k === "plan" || (k === "on" && "reason" in record)) v7IdsIn(x, into);
      } else stack.push(x);
    }
  }
  const ledger = (value as Partial<RoomState> | null)?.saveOutcomes;
  if (ledger) for (const id of Object.keys(ledger)) into.add(id);
}

/**
 * The scene a room was made with (shared/initial.ts), the earliest made
 * within FIRST_SCENE_MS after its first member, whose id says only when
 * that member's does. Null when no scene fits.
 */
function firstScene(state: RoomState, members: ReadonlySet<string>): string | null {
  const times = [...members].flatMap((id) => {
    const t = idTime(id);
    return t === null ? [] : [t];
  });
  if (times.length === 0) return null;
  const made = Math.min(...times);
  let first: { id: string; t: number } | null = null;
  for (const id of Object.keys(state.scenes)) {
    const t = idTime(id);
    if (t === null || t < made || t - made > FIRST_SCENE_MS) continue;
    if (first === null || t < first.t) first = { id, t };
  }
  return first?.id ?? null;
}

/** `text` with every renamed id in it written as its new one. */
export function renamedText(text: string, renames: ReadonlyMap<string, string>): string {
  return text.replace(V7_TEXT, (id) => renames.get(id) ?? id);
}

/**
 * The state with each renamed id written as its new one in every string,
 * keys included and in their places, so maps keep their order. A sync
 * record follows its rolls' and resources' new ids, and the lists the
 * reducer keeps in id order are sorted again (inIdOrderAgain).
 */
export function renamedState(state: RoomState, renames: ReadonlyMap<string, string>): RoomState {
  if (renames.size === 0) return state;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.length >= 36 ? renamedText(v, renames) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k.length >= 36 ? renamedText(k, renames) : k] = walk(x);
    return out;
  };
  return inIdOrderAgain(walk(withSyncRekeyed(state, renames)) as RoomState, new Set(renames.values()));
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The lists the reducer writes in id order, sorted again by the ids they
 * hold now, where they hold a new one, so none keeps the order of the
 * version 7 ids it held:
 * - a history step's walks, by creature;
 * - a trap occurrence's creatures it hits, which a group save's rows keep
 *   on a name tie (client/features/dice/groupSave/rows.ts groupRows), so
 *   the HP lines players read follow it;
 * - who set it off, those players own or saw first, which Do its effects
 *   names to players in that order (shared/reducer/traps.ts trapAct). The
 *   creatures players saw are those the DM's trap line marks, and those
 *   players own, those they own now;
 * - a fall card's riders, which its group save's rows keep on a name tie.
 * Every other list of ids keeps its order: no output follows it (a step's
 * companions' Reactions, the creatures a turn revealed, a turn's mounts),
 * it is the order an asker or the DM chose (an ask's targets, a roll
 * request's), or it is a line players read already (`trapSeen`).
 */
function inIdOrderAgain(state: RoomState, fresh: ReadonlySet<string>): RoomState {
  const holdsFresh = (ids: readonly string[]) => ids.some((id) => fresh.has(id));
  if (state.encounterHistory.some((step) => step.walks !== undefined)) {
    state.encounterHistory = state.encounterHistory.map((step) => (step.walks === undefined ? step : { ...step, walks: [...step.walks].sort((a, b) => byCodeUnit(a.tokenId, b.tokenId)) }));
  }
  for (const trap of Object.values(state.traps ?? {})) {
    const due = trap.rig?.due;
    if (!trap.rig || !due?.some((d) => holdsFresh(d.hits) || holdsFresh(d.by))) continue;
    trap.rig.due = due.map((d) => {
      const out = { ...d };
      if (holdsFresh(d.hits)) out.hits = [...d.hits].sort(byCodeUnit);
      if (holdsFresh(d.by)) {
        const line = state.trapLog.find((l) => l.id === d.id)?.data;
        const marked = new Set(line?.type === "trap" ? (line.seen ?? []).map((i) => line.by[i]) : []);
        const shown = (id: string) => {
          const token = ownEntry(state.tokens, id);
          return marked.has(id) || (token !== undefined && playersToken(state, token));
        };
        const sorted = [...d.by].sort(byCodeUnit);
        out.by = [...sorted.filter(shown), ...sorted.filter((id) => !shown(id))];
      }
      return out;
    });
  }
  for (const card of Object.values(state.falls ?? {})) {
    if (card.riders && holdsFresh(card.riders)) card.riders = [...card.riders].sort(byCodeUnit);
  }
  return state;
}

/** Each character's sync record keyed by its rolls' and resources' new ids (shared/rules/pcSync.ts rekeySync). */
function withSyncRekeyed(state: RoomState, renames: ReadonlyMap<string, string>): RoomState {
  let characters: RoomState["characters"] | null = null;
  for (const [id, character] of Object.entries(state.characters)) {
    if (!character.ddbSync) continue;
    const own = new Map<string, string>();
    for (const thing of [...(character.stats?.rolls ?? []), ...(character.resources ?? [])]) {
      const to = renames.get(thing.id);
      if (to !== undefined) own.set(thing.id, to);
    }
    if (own.size === 0) continue;
    characters ??= { ...state.characters };
    characters[id] = { ...character, ddbSync: rekeySync(character.ddbSync, own) };
  }
  return characters === null ? state : { ...state, characters };
}

/** Rows a read or write of the archive takes at a time. */
const ROWS = 500;

/** Every member id the room's other tables name, a former member's too: none of them is given anew. */
async function storedMemberIds(pool: Pool, roomId: string): Promise<string[]> {
  const { rows } = await pool.query<{ member_id: string }>(
    `select member_id from grants where room_id = $1
     union select member_id from room_dm_members where room_id = $1
     union select member_id from roll_receipts where room_id = $1
     union select member_id from room_ids where room_id = $1
     union select member_id from room_log_access where room_id = $1
     union select u.member_id from asset_uploaders u join assets a on a.id = u.asset_id where a.room_id = $1`,
    [roomId],
  );
  return rows.map((r) => r.member_id);
}

/** What the first load on this build did: the room as loaded from its new snapshot, how many ids it gave anew, and how many archived rows it rewrote. */
export type Reid = { loaded: LoadedRoom; renamed: number; rows: number };

/**
 * Gives a loaded room's ids anew (ReidPlan) and stores the result: the
 * archived rows that name a renamed id, the receipts' asks, and a snapshot
 * at the loaded seq at today's format with the room's count, in one
 * transaction. The id gate's
 * rows stay as they are. Any failure throws and stores nothing, so the
 * next load starts again from the stored room.
 */
export async function reidRoom(pool: Pool, roomId: string, loaded: LoadedRoom, newId: () => string): Promise<Reid> {
  const plan = new ReidPlan(loaded.state, await storedMemberIds(pool, roomId));
  const rowIds = new Map<string, string[]>();
  for (let after = ""; ; ) {
    const { rows } = await pool.query<{ id: string; text: string; complete: boolean }>(
      "select id, entry::text as text, seq is not null as complete from room_log where room_id = $1 and id > $2 order by id limit $3",
      [roomId, after, ROWS],
    );
    const found = plan.addLines(rows.map((r) => ({ entry: JSON.parse(r.text) as LogEntry, complete: r.complete, text: r.text })));
    rows.forEach((r, i) => {
      if (found[i]!.length > 0) rowIds.set(r.id, found[i]!);
    });
    if (rows.length < ROWS) break;
    after = rows[rows.length - 1]!.id;
  }
  const renames = plan.renames(newId);
  const state = renamedState(loaded.state, renames);
  const touched = [...rowIds].flatMap(([id, ids]) => (ids.some((x) => renames.has(x)) ? [id] : []));
  const json = snapshotJson(state);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    for (let i = 0; i < touched.length; i += ROWS) {
      const { rows } = await client.query<{ id: string; text: string }>("select id, entry::text as text from room_log where room_id = $1 and id = any($2::text[])", [roomId, touched.slice(i, i + ROWS)]);
      await client.query("update room_log l set entry = u.e::jsonb from unnest($2::text[], $3::text[]) as u(i, e) where l.room_id = $1 and l.id = u.i", [
        roomId,
        rows.map((r) => r.id),
        rows.map((r) => renamedText(r.text, renames)),
      ]);
    }
    if (renames.size > 0) {
      await client.query("update roll_receipts r set ask = u.n from unnest($2::text[], $3::text[]) as u(o, n) where r.room_id = $1 and r.ask = u.o", [roomId, [...renames.keys()], [...renames.values()]]);
    }
    await storeSnapshot(client, roomId, loaded.seq, json);
    // The count goes with it, as a commit's does, since the snapshot takes the place of the one a first commit carries.
    await client.query("update rooms set pub = $2 where id = $1", [roomId, loaded.pub]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
  return { loaded: { ...loaded, state, snapshotSeq: loaded.seq, stateBytes: Buffer.byteLength(json) }, renamed: renames.size, rows: touched.length };
}
