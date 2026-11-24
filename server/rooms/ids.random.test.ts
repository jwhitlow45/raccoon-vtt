import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import { ID_TIME_REFUSED, idKeyOf, isUuidv7, sealedId, sealedTime, type IdKey } from "#shared/ids.ts";
import { ID_PAGE_OLD, ID_SEAL_GRACE_MS, ID_TIME } from "#shared/limits.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { derivedId } from "#shared/reducer/duplicate.ts";
import { character, rng, template } from "#shared/testutil.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../config.ts";
import type { ActorOptions } from "./actor.ts";
import { IdTable } from "./limitsTwinTesting.ts";
import { remapState } from "./remap.ts";
import { each, inF, inR, make, move, numberingRoom, patch, Room, T0 } from "./numberingTesting.ts";
import { ScopeClient, STANDING_CLOCK } from "./undoScopeTesting.ts";

/**
 * Seeded runs in twin rooms whose DM makes every thing at its own random
 * time in each (9.2): creates in every shape, hides, reveals, moves,
 * deletes and the DM's undo and redo of them, a scene's duplicate, a group
 * save's outcome with its conditions, P1's resync of their character's
 * class resources, P1's areas, page reloads, restarts, clock steps, a
 * change of ROOM_SECRET_KEY, pages without a key and the change over, and
 * after each run an import of each room:
 *
 * - I1: every id a keyed page made for a new thing that the room took is
 *   version 8 and reads under the sender's key to the time it was made.
 * - I2: no id the DM made reads, under P1's key or no one's, within 31
 *   minutes of when it was made.
 * - I3: P1's and the display's frames are the same in both twins, each id
 *   as its label, and so is P1's copy of each twin's import.
 * - I4: every create is answered as the gate's model says: the shape and
 *   the key, the window, a row, the change over.
 * - I5: a create lands exactly when it is taken, once.
 * - C17: a create made before a key change goes after it with at most one
 *   refusal, as a page's one retry sends it again. A page's own store
 *   across a key change, its create queued, written or unanswered, is
 *   client/state/ids.actor.test.ts.
 */

const MINUTE = 60_000;
const NOBODY = idKeyOf(randomBytes(32));
const STALE = { code: "invalid", message: ID_TIME_REFUSED };
const OLD_PAGE = { code: "invalid", message: ID_PAGE_OLD };
type Answer = "taken" | { code: string; message: string };

function nonce(label: string): Uint8Array {
  const n = createHash("sha256").update(`random ${label}`).digest().subarray(0, 8);
  n[0]! &= 0x0f;
  return new Uint8Array(n);
}

/** A version 7 id at `t` from a label, so both twins make the same one. */
function v7At(label: string, t: number): string {
  const h = createHash("sha256").update(`v7 ${label}`).digest("hex");
  const time = t.toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${h.slice(0, 3)}-${"89ab"[Number.parseInt(h[3]!, 16) % 4]}${h.slice(4, 7)}-${h.slice(7, 19)}`;
}

type Twin = {
  room: Room;
  opts: Partial<ActorOptions>;
  table: IdTable;
  keyed: { dm: ScopeClient; p1: ScopeClient };
  /** Each labelled id and when it was made. */
  labels: Map<string, { label: string; at: number }>;
  /** Draws this twin's own making times for the DM. */
  r: () => number;
};

async function openKeyed(tw: Twin): Promise<void> {
  const open = (who: "dm" | "p1") => ScopeClient.open(tw.room.actor, tw.room.member(who), who === "dm" ? "dm" : "player", () => tw.room.clock.now, undefined, true);
  tw.keyed = { dm: await open("dm"), p1: await open("p1") };
}

async function openTwin(t: TestContext, name: string, seed: number): Promise<Twin> {
  // One options object per twin, so a key change reaches its next load.
  const opts: Partial<ActorOptions> = { idGate: true, numberClock: STANDING_CLOCK, standingClock: true, idSecret: DEVELOPMENT_ROOM_SECRET_KEY };
  const state = numberingRoom();
  state.characters.c1 = character("c1", { name: "Ayla", ownerIds: ["p1"], resources: [] });
  const room = new Room(t, name, state, opts);
  const table = new IdTable().attach(room);
  table.since = T0 - 120 * MINUTE;
  await room.load();
  const tw: Twin = { room, opts, table, keyed: null as never, labels: new Map(), r: rng(seed) };
  await openKeyed(tw);
  return tw;
}

async function sendBy(tw: Twin, client: ScopeClient, op: Op): Promise<Answer> {
  tw.room.clock.now += 1_000;
  const event = await client.send(op);
  await tw.room.settle();
  const refusal = event.rejects?.find((r) => r.n === client.n);
  return refusal ? { code: refusal.code, message: refusal.message ?? "" } : "taken";
}

const area = (id: string): Op => {
  const { rev: _rev, ...made } = template(id, { ownerId: "p1", origin: { x: 4.5, y: 4.5, z: 0 }, size: 5 });
  return { t: "template.create", template: made } as Op;
};

/** P1's frames, history ids aside (Room.p1Frames), each labelled id as its label. */
function framesOf(tw: Twin): string[] {
  const table = [...tw.labels];
  return tw.room.p1Frames().map((text) => {
    let out = text;
    for (const [id, { label }] of table) out = out.split(id).join(`<${label}>`);
    return out;
  });
}

/**
 * P1's copy of the room as an import makes it (remap.ts), every id but the
 * members' made anew in the order the import asks, sealed under one key at
 * one time, so twins whose ids differ only in their times give the same.
 */
function importedCopy(state: RoomState): { copy: string; held: string } {
  let made = 0;
  const key = idKeyOf(createHash("sha256").update("the import's server key").digest());
  const remapped = remapState(state, {
    assets: new Map(),
    memberIds: new Map(Object.keys(state.members).map((id) => [id, id])),
    newId: () => sealedId(key, T0, nonce(`import ${made++}`)),
  });
  return { copy: JSON.stringify(projectState(remapped, { memberId: "p1", role: "player" }, { sceneId: null })), held: JSON.stringify(remapped) };
}

describe("ids through random runs in twin rooms (9.2)", () => {
  test("I1 to I5 and C17 hold over seeded runs", async (t) => {
    let creates = 0;
    let taken = 0;
    let keyChanges = 0;
    let changeOvers = 0;
    const kinds = new Map<string, number>();
    const count = (kind: string) => kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    for (let seed = 1; seed <= 16; seed++) {
      const pair = [await openTwin(t, "A", 1_000 + seed), await openTwin(t, "B", 2_000 + seed)] as const;
      const r = rng(seed);
      const live: string[] = [];
      const gone: string[] = [];
      let n = 0;
      let sealedOnly = false;
      let unsent: { label: string; ids: [string, string] } | null = null;
      const what = (step: string) => `seed ${seed} step ${n} ${step}`;
      const both = async (step: string, send: (tw: Twin, i: number) => Promise<Answer>): Promise<Answer> => {
        const answers = [await send(pair[0], 0), await send(pair[1], 1)];
        assert.deepEqual(answers[0], answers[1], `${what(step)}: both twins answer alike`);
        return answers[0]!;
      };
      /** The DM's create of a fresh labelled thing, each twin at its own time, and the model's answer for it. */
      const create = async (label: string, shape: "sealed" | "stale" | "v7keyed" | "unkeyed", place: "seen" | "unseen") => {
        creates++;
        const expected: Answer = shape === "stale" || shape === "v7keyed" ? STALE : shape === "unkeyed" && sealedOnly ? OLD_PAGE : "taken";
        const ids: string[] = [];
        const cell = place === "seen" ? inR(int(r, 0, 4), int(r, 0, 3)) : inF(int(r, 0, 4), int(r, 0, 3));
        const answer = await both(`create ${label}`, async (tw) => {
          const now = tw.room.clock.now + 1_000;
          // Each twin makes its DM's thing at its own time in the window, a stale one past it.
          const at = shape === "stale" ? now - ID_TIME.behindMs - 5 * MINUTE : now - Math.floor(tw.r() * 25 * MINUTE);
          const key = tw.keyed.dm.idKey!;
          const id = shape === "sealed" || shape === "stale" ? sealedId(key, at, nonce(label)) : v7At(label, now);
          ids.push(id);
          tw.labels.set(id, { label, at: shape === "sealed" || shape === "stale" ? at : now });
          const client = shape === "unkeyed" ? tw.room.clients.dm : tw.keyed.dm;
          return sendBy(tw, client, make(id, cell, { name: "Goblin" }));
        });
        assert.deepEqual(answer, expected, what(`I4: create ${label} as ${shape}`));
        for (const [i, tw] of pair.entries()) {
          const held = tw.room.state.tokens[ids[i]!] !== undefined;
          assert.equal(held, answer === "taken", what(`I5: ${label} lands exactly when taken`));
          if (answer === "taken" && shape === "sealed") assert.equal(sealedTime(tw.keyed.dm.idKey!, ids[i]!), tw.labels.get(ids[i]!)!.at, what("I1"));
        }
        if (answer === "taken") {
          taken++;
          live.push(label);
        }
      };
      const idOf = (tw: Twin, label: string) => [...tw.labels].find(([, v]) => v.label === label)![0];
      await create("first", "sealed", "seen");
      for (; n < 24; n++) {
        const step = int(r, 0, 15);
        if (step <= 2) {
          await create(`thing ${n}`, pick(r, ["sealed", "sealed", "sealed", "stale", "v7keyed", "unkeyed"] as const), pick(r, ["seen", "unseen"] as const));
        } else if (step === 3 && live.length > 0) {
          const label = pick(r, live);
          await both("hide or show", (tw) => sendBy(tw, tw.room.clients.dm, patch(idOf(tw, label), { visibility: pick(rng(n), ["dm", "all"]) })));
        } else if (step === 4 && live.length > 0) {
          const label = pick(r, live);
          await both("move", (tw) => sendBy(tw, tw.room.clients.dm, move(idOf(tw, label), pick(rng(n + 1), [inR(1, 1), inF(1, 1)]))));
        } else if (step === 5 && live.length > 0) {
          const label = live.splice(Math.floor(r() * live.length), 1)[0]!;
          assert.equal(await both("delete", (tw) => sendBy(tw, tw.room.clients.dm, { t: "token.delete", tokenId: idOf(tw, label) } as Op)), "taken");
          gone.push(label);
        } else if (step === 6 && gone.length > 0) {
          // The deleted thing's id made again: the room took it already, so it is gone, or past the window by now. Each
          // twin's DM made it at its own time, and only that DM can send it, so the twins may answer apart.
          const label = pick(r, gone);
          for (const tw of pair) {
            const answer = await sendBy(tw, tw.keyed.dm, make(idOf(tw, label), inF(0, 0), { name: "Goblin" }));
            assert.notEqual(answer, "taken", what(`I4: ${tw.room.name}: an id the room took is never taken again`));
          }
        } else if (step === 7) {
          const label = `area ${n}`;
          creates++;
          const answer = await both("P1's area", async (tw) => {
            const now = tw.room.clock.now + 1_000;
            const id = sealedId(tw.keyed.p1.idKey!, now, nonce(label));
            tw.labels.set(id, { label, at: now });
            return sendBy(tw, tw.keyed.p1, area(id));
          });
          assert.equal(answer, "taken", what("I4: P1's sealed area"));
          taken++;
        } else if (step === 8) {
          await each([pair[0].room, pair[1].room], (room) => room.reloadP1());
        } else if (step === 9) {
          // The clock moves on, within what a page's ids may lag.
          const by = int(r, 1, 10) * MINUTE;
          for (const tw of pair) tw.room.clock.now += by;
        } else if (step === 10) {
          // C17: an id made before a change of ROOM_SECRET_KEY goes after it with at most one refusal.
          const secret = randomBytes(32);
          keyChanges++;
          unsent = { label: `unsent ${n}`, ids: ["", ""] };
          for (const [i, tw] of pair.entries()) {
            const id = sealedId(tw.keyed.dm.idKey!, tw.room.clock.now, nonce(unsent.label));
            unsent.ids[i] = id;
            tw.labels.set(id, { label: unsent.label, at: tw.room.clock.now });
            tw.opts.idSecret = secret;
            await tw.room.restart(false);
            await openKeyed(tw);
          }
          const first = await both("C17 the unsent create", (tw, i) => sendBy(tw, tw.keyed.dm, make(unsent!.ids[i]!, inF(2, 2), { name: "Goblin" })));
          if (first !== "taken") {
            assert.deepEqual(first, STALE, what("C17: refused once, in the words a page retries on"));
            const again = await both("C17 the one retry", async (tw) => {
              const id = sealedId(tw.keyed.dm.idKey!, tw.room.clock.now, nonce(`${unsent!.label} again`));
              tw.labels.set(id, { label: `${unsent!.label} again`, at: tw.room.clock.now });
              return sendBy(tw, tw.keyed.dm, make(id, inF(2, 2), { name: "Goblin" }));
            });
            assert.equal(again, "taken", what("C17: the retry lands"));
          }
        } else if (step === 12 && live.length > 0) {
          // The DM deletes a thing and takes it back, and may delete it again: a restore brings back its own id.
          const label = pick(r, live);
          assert.equal(await both("delete to undo", (tw) => sendBy(tw, tw.room.clients.dm, { t: "token.delete", tokenId: idOf(tw, label) } as Op)), "taken");
          await each([pair[0].room, pair[1].room], (room) => room.restore("undo"));
          for (const tw of pair) assert.ok(tw.room.state.tokens[idOf(tw, label)], what("the undo brings it back under its id"));
          count("undo");
          if (r() < 0.5) {
            await each([pair[0].room, pair[1].room], (room) => room.restore("redo"));
            live.splice(live.indexOf(label), 1);
            gone.push(label);
            count("redo");
          }
        } else if (step === 13) {
          // The DM duplicates the scene with its creatures: the copy's id is minted, its creatures' derived from it.
          const label = `copy ${n}`;
          creates++;
          const answer = await both("duplicate", async (tw) => {
            const now = tw.room.clock.now + 1_000;
            const id = sealedId(tw.keyed.dm.idKey!, now, nonce(label));
            tw.labels.set(id, { label, at: now });
            for (const tok of Object.values(tw.room.state.tokens)) {
              if (tok.sceneId !== "s1") continue;
              const of = tw.labels.get(tok.id)?.label ?? tok.id;
              tw.labels.set(derivedId(id, tok.id, OP_VERSION), { label: `${label} of ${of}`, at: now });
            }
            return sendBy(tw, tw.keyed.dm, { t: "scene.duplicate", sceneId: "s1", newSceneId: id, name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } } as Op);
          });
          assert.equal(answer, "taken", what("I4: the DM's sealed duplicate"));
          taken++;
          count("duplicate");
        } else if (step === 14 && live.length > 0) {
          // A group save's outcome: its plan id stays version 7, its condition's id is the DM's sealed one, recorded.
          const target = pick(r, live);
          const label = `prone ${n}`;
          const answer = await both("outcome", async (tw) => {
            const now = tw.room.clock.now + 1_000;
            const id = sealedId(tw.keyed.dm.idKey!, now, nonce(label));
            tw.labels.set(id, { label, at: now });
            return sendBy(tw, tw.keyed.dm, { t: "actor.outcome", plan: v7At(`plan ${n}`, now), label: "Prone", targets: [{ target: { tokenId: idOf(tw, target) }, effects: [{ id, key: "prone" }] }] } as Op);
          });
          assert.equal(answer, "taken", what("I4: the outcome's sealed condition"));
          count("outcome");
        } else if (step === 15) {
          // P1 resyncs their character: a new class resource, under P1's key, or version 7 from a keyed page, refused.
          const label = `rage ${n}`;
          const shape = pick(r, ["sealed", "sealed", "v7keyed"] as const);
          const answer = await both("resync", async (tw) => {
            const now = tw.room.clock.now + 1_000;
            const id = shape === "sealed" ? sealedId(tw.keyed.p1.idKey!, now, nonce(label)) : v7At(label, now);
            tw.labels.set(id, { label, at: now });
            const resources = [...(tw.room.state.characters.c1!.resources ?? []), { id, name: "Rage", max: 2, used: 0, reset: "long" as const }].slice(-12);
            return sendBy(tw, tw.keyed.p1, { t: "character.update", characterId: "c1", patch: { resources } } as Op);
          });
          assert.deepEqual(answer, shape === "sealed" ? "taken" : STALE, what(`I4: P1's ${shape} resource`));
          count("resync");
        } else if (step === 11 && !sealedOnly && r() < 0.3) {
          // The change over: an hour after this server first ran the build, as the rooms load again.
          sealedOnly = true;
          changeOvers++;
          for (const tw of pair) {
            tw.table.sealedSince = tw.room.clock.now - ID_SEAL_GRACE_MS - MINUTE;
            await tw.room.restart(false);
            await openKeyed(tw);
          }
        }
      }
      // Each twin imported: P1's copy is the same in both, and holds no id of a thing the room holds. A line about a
      // thing since deleted keeps the id it names, as nothing in the room resolves it (remap.ts Ids.of).
      const imports = pair.map((tw) => importedCopy(tw.room.state));
      assert.equal(imports[0]!.copy, imports[1]!.copy, `seed ${seed}: I3: P1's copy of each import`);
      for (const [i, tw] of pair.entries()) {
        const holds = JSON.stringify({ ...tw.room.state, log: [], trapLog: [], trapSeen: [], encounterHistory: [] });
        for (const [id, { label }] of tw.labels) {
          if (holds.includes(id)) assert.ok(!imports[i]!.held.includes(id), `seed ${seed}: the import keeps no id of ${label}`);
        }
      }
      count("import");
      const [a, b] = pair.map(framesOf);
      const at = a!.findIndex((f, i) => f !== b![i]);
      const c = at < 0 ? 0 : [...a![at]!].findIndex((ch, k) => ch !== b![at]![k]);
      assert.ok(at < 0 && a!.length === b!.length, `seed ${seed}: I3, first apart at ${at}, character ${c}:\nA ${a![at]?.slice(Math.max(0, c - 300), c + 200)}\nB ${b![at]?.slice(Math.max(0, c - 300), c + 200)}`);
      for (const tw of pair) {
        const held = tw.room.pages.map((p) => JSON.stringify(p.sent)).join("");
        for (const [id, { at: madeAt, label }] of tw.labels) {
          // P1's own areas and resources read under P1's key, as they should.
          if (!held.includes(id) || isUuidv7(id) || label.startsWith("area") || label.startsWith("rage")) continue;
          for (const key of [tw.keyed.p1.idKey!, NOBODY] as IdKey[]) {
            const read = sealedTime(key, id);
            assert.ok(read === null || Math.abs(read - madeAt) > 31 * MINUTE, `seed ${seed}: I2: ${label} reads near when it was made`);
          }
        }
      }
    }
    assert.ok(taken > 50 && creates > taken, `${taken} of ${creates} creates taken`);
    assert.ok(keyChanges >= 3 && changeOvers >= 2, `${keyChanges} key changes and ${changeOvers} change overs`);
    for (const kind of ["undo", "redo", "duplicate", "outcome", "resync", "import"]) assert.ok((kinds.get(kind) ?? 0) >= 3, `${kinds.get(kind) ?? 0} ${kind} steps`);
  });
});

function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}
