import { holderChunkKey } from "./keys.ts";
import type { RoomState, Stamp } from "./model.ts";
import { stableStringify } from "./project.ts";
import { twins, type TwinOptions, type Twins } from "./secretDoorTestutil.ts";
import type { Playing, Sound } from "./sound.ts";
import { token } from "./testutil.ts";

/**
 * Helpers for the room count's twin tests (server/rooms/seq.twin.test.ts,
 * seq.random.test.ts, seq.itest.ts and the secret door twin tests): two
 * rooms that take the same members' ops while what the server does on its
 * own differs, and what each device got from each, compared whole.
 * Nothing here runs in the app.
 */

/** A room number a device was given: where it sits, the count it reads, and both as one line. */
export type Given = { what: string; n: number; text: string };

/** A log or trap line id, `"<count>:<index>"`. */
const LINE_ID = /^(\d+):(\d+)$/;
const LINE_KEY = /^(?:log|trapLog|trapSeen):(\d+):(\d+)$/;

/**
 * Every room number the frames carry, in order: each `ev`, `snapshot` and
 * `history` frame's `seq`, every log and trap line id (a change's key, a
 * line's own id and any line a value names), each `turnStart.seq`, a path's
 * `turn`, a turn record's `id`, and every other `seq` a value holds, a
 * receipt part's among them. An object that is not a frame, such as a
 * receipt's answer, is read the same way. A device's own numbers (`n`,
 * watermarks, history serials and depths) are not room numbers and are
 * left out.
 */
export function numbersIn(frames: readonly unknown[]): Given[] {
  const out: Given[] = [];
  const walk = (value: unknown, key: string, parent: string): void => {
    if (typeof value === "string") {
      const line = LINE_ID.exec(value);
      if (line) out.push({ what: "id", n: Number(line[1]), text: `id ${value}` });
      return;
    }
    if (typeof value === "number") {
      if (key === "seq" || key === "startSeq") out.push({ what: `${parent}.${key}`, n: value, text: `${parent}.${key} ${value}` });
      else if (key === "turn" && parent === "path") out.push({ what: "path.turn", n: value, text: `path.turn ${value}` });
      else if (key === "id" && parent === "turnRecord") out.push({ what: "turnRecord.id", n: value, text: `turnRecord.id ${value}` });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, parent);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const k of Object.keys(value).sort()) walk((value as Record<string, unknown>)[k], k, key);
  };
  for (const frame of frames) {
    if (frame === null || typeof frame !== "object") continue;
    const f = frame as { t?: unknown; seq?: unknown; changes?: unknown; state?: unknown };
    if (f.t === undefined) {
      walk(frame, "", "");
      continue;
    }
    if (typeof f.seq === "number" && (f.t === "ev" || f.t === "snapshot" || f.t === "history")) out.push({ what: f.t, n: f.seq, text: `${f.t} ${f.seq}` });
    if (f.t === "ev" && Array.isArray(f.changes)) {
      for (const change of f.changes as Array<{ key: string; value?: unknown }>) {
        const line = LINE_KEY.exec(change.key);
        if (line) out.push({ what: "id", n: Number(line[1]), text: `id ${line[1]}:${line[2]}` });
        walk(change.value, change.key.slice(0, change.key.indexOf(":")), "");
      }
    } else if (f.t === "snapshot") walk(f.state, "state", "");
  }
  return out;
}

/** The kinds FrameReader compares without their `rev`: by a change's key kind, and by a collection's name in a state. */
export const KINDS_WITHOUT_REV: ReadonlySet<string> = new Set(["template", "drawing", "stamp", "label", "handout", "handoutDoc", "pin", "cast"]);
const COLLECTIONS_WITHOUT_REV: ReadonlySet<string> = new Set(["templates", "drawings", "stamps", "labels", "handouts", "handoutDocs", "pins", "casts"]);

function withoutKindRevs(value: unknown, entry: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutKindRevs(v, false));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (entry && k === "rev") continue;
    // A collection is a record by id, wherever it sits: the state's, or a remembered chunk's labels and stamps.
    if (COLLECTIONS_WITHOUT_REV.has(k) && v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([id, e]) => [id, withoutKindRevs(e, true)]));
    } else out[k] = withoutKindRevs(v, false);
  }
  return out;
}

/**
 * Reads one twin's frames for comparison, each as one line of text: the
 * history's epochs and head ids become ids in the order this twin first
 * showed them, so two twins' frames are equal only while their ids pair
 * one to one, and the kinds of KINDS_WITHOUT_REV lose their `rev`. Use one
 * reader per twin, over every socket compared, in the same order in both
 * twins.
 */
export class FrameReader {
  #ids = new Map<string, string>();

  #id(raw: string): string {
    let id = this.#ids.get(raw);
    if (id === undefined) {
      id = `history-${this.#ids.size + 1}`;
      this.#ids.set(raw, id);
    }
    return id;
  }

  text(frame: unknown): string {
    if (frame === null || typeof frame !== "object") return stableStringify(frame);
    const f = frame as Record<string, unknown>;
    if (f.t === "history") return stableStringify(this.#history(f));
    if (f.t === "ev" && Array.isArray(f.changes)) {
      const changes = (f.changes as Array<{ key: string; value?: unknown }>).map((c) => ("value" in c ? { ...c, value: withoutKindRevs(c.value, KINDS_WITHOUT_REV.has(c.key.slice(0, c.key.indexOf(":")))) } : c));
      return stableStringify({ ...f, changes });
    }
    if (f.t === "snapshot") return stableStringify({ ...f, state: withoutKindRevs(f.state, false) });
    return stableStringify(frame);
  }

  /** Each frame as `text` reads it. */
  texts(frames: readonly unknown[]): string[] {
    return frames.map((f) => this.text(f));
  }

  #history(f: Record<string, unknown>): unknown {
    const scope = (s: unknown): unknown => {
      if (s === null || typeof s !== "object") return s;
      const out: Record<string, unknown> = {};
      for (const [direction, stack] of Object.entries(s)) {
        const head = (stack as { head?: { id?: unknown } | null }).head;
        out[direction] = head && typeof head.id === "string" ? { ...(stack as object), head: { ...head, id: this.#id(head.id) } } : stack;
      }
      return out;
    };
    const out: Record<string, unknown> = { ...f };
    if (typeof f.epoch === "string") out.epoch = this.#id(f.epoch);
    if ("play" in f) out.play = scope(f.play);
    if ("setup" in f) out.setup = scope(f.setup);
    return out;
  }
}

/** The twins' clock at the start: the music's run starts here. */
export const T0 = Date.parse("2026-11-02T20:00:00.000Z");
/** Where the DM puts Bree in room Q, past the passage, out of every square Ayla's side may hold. */
export const IN_Q = { x: 22, y: 6 } as const;
/** P2's familiar in room Q, which P2 owns in the door twin only. */
export const FAMILIAR = "f";
/** The image a stamp in P2's memory shows, in the door twin only. */
export const IMAGE = "0199f0a0-0000-7000-8000-00000000a1a1";
/** The file of the door twin's music. */
export const TRACK_FILE = "0199f0a0-0000-7000-8000-00000000a2a2";
/** When the door twin's first track has ended, past its 5 s crossfade into the next. */
export const TRACK_END = T0 + 60_000;

export type SeqTwinOptions = Partial<Pick<TwinOptions, "wide" | "rule">> & {
  /** Only DM devices in both twins, and music playing in the door twin. */
  music?: boolean;
  /** A stamp of IMAGE in P2's memory of room Q, in the door twin. */
  stamp?: boolean;
  /** FAMILIAR in room Q, hidden from players but its owner, P2's in the door twin and the DM's in the twin of rock. */
  familiar?: boolean;
};

function music(): Pick<RoomState, "sounds" | "playlists" | "playing"> {
  const sound = (id: string): Sound => ({ id, rev: 0, name: id, assetId: TRACK_FILE, ms: 60_000, use: "music" });
  const playing: Playing = {
    rev: 1,
    music: { run: "r0", playlistId: "night", order: ["a", "b"], index: 0, repeat: "all", fade: 5, now: { soundId: "a", at: T0 } },
    loops: {},
    effects: [],
    volume: { music: 100, effects: 100 },
  };
  return { sounds: { a: sound("a"), b: sound("b") }, playlists: { night: { id: "night", rev: 0, name: "Night", sounds: ["a", "b"], repeat: "all", fade: 5 } }, playing };
}

function stampInMemory(): Stamp {
  return { id: "st1", rev: 1, sceneId: "s1", art: { assetId: IMAGE }, x: 24.5, y: 8.5, w: 1, h: 1, rotation: 0, z: 1, visibility: "all" };
}

/**
 * The twins of the secret door test on Explore per player
 * (secretDoorTestutil.ts `twins`), with both players sight holders, so
 * P2's walks in room Q write P2's layer alone, and in the door twin alone
 * the room explores and remembers what P2 sees there. The options add
 * more the door twin alone holds and no other player sees.
 */
export function seqTwins(opts: SeqTwinOptions = {}): Twins {
  const { music: withMusic, stamp, familiar, ...shape } = opts;
  const w = twins({ cover: "auto", explore: true, perPlayer: true, ...shape });
  for (const s of [w.door, w.rock]) {
    s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
    if (withMusic) s.meta = { ...s.meta, settings: { ...s.meta.settings, soundDmOnly: true } };
    if (familiar) s.tokens[FAMILIAR] = token(FAMILIAR, { kind: "pc", name: "Owl", ownerIds: s === w.door ? ["p2"] : [], disposition: "ally", visibility: "dm", x: 24, y: 4 });
  }
  if (withMusic) Object.assign(w.door, music());
  if (stamp) w.door.memoryBy = { ...w.door.memoryBy, [holderChunkKey("s1", "p2", 1, 0)]: { sceneId: "s1", cx: 1, cy: 0, rev: 1, memberId: "p2", stamps: { st1: stampInMemory() } } };
  return w;
}
