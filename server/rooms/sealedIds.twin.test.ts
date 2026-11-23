import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import { idKeyOf, idTime, isSealedShape, isUuidv7, sealedId, sealedTime, type IdKey } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { derivedId } from "#shared/reducer/duplicate.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../config.ts";
import { RoomIdKeys } from "./idKeys.ts";
import { openTwins, type Twins } from "./limitsTwinTesting.ts";
import { token } from "#shared/testutil.ts";
import { each, inF, inR, make, move, numberingRoom, T0, type Room } from "./numberingTesting.ts";
import { v7IdsIn } from "./reid.ts";
import { remapState } from "./remap.ts";
import { STANDING_CLOCK } from "./undoScopeTesting.ts";

/**
 * Twin rooms that differ only in when, or in which order, the DM made
 * things P1 does not see (C2 to C7): each thing's id is sealed under the
 * DM's key from a nonce of its own label (`nonce`), so the twins' ids
 * differ in their sealed time alone. P1's and the display's raw frames,
 * snapshots and batches, with each id written as its label, are the same
 * byte for byte, maps and numbers in the same order. Apart from that, no
 * id P1 holds reads, under P1's key or a key of no one's, to the time it
 * was made, and a chance match of a tag comes as often as 1 in 16,384.
 */

const MINUTE = 60_000;
const KEYS = new RoomIdKeys(DEVELOPMENT_ROOM_SECRET_KEY, "UNDOSCOPE");
const DM_KEY = KEYS.member("dm1").key;
const P1_KEY = KEYS.member("p1").key;
const NOBODY = idKeyOf(randomBytes(32));

/** One nonce per logical thing, from its label alone, never from the order things are made in. */
function nonce(label: string): Uint8Array {
  const n = createHash("sha256").update(`twin ${label}`).digest().subarray(0, 8);
  n[0]! &= 0x0f;
  return new Uint8Array(n);
}

/** Each twin's ids by label, with when each was made. */
class Labels {
  readonly #byId = new Map<string, { label: string; at: number }>();
  /** The DM's id for `label`, made `agoMs` before the room's clock. */
  dm(room: Room, label: string, agoMs = 0): string {
    const at = room.clock.now - agoMs;
    return this.add(sealedId(DM_KEY, at, nonce(label)), label, at);
  }
  add(id: string, label: string, at: number): string {
    this.#byId.set(id, { label, at });
    return id;
  }
  /** When the thing labelled by `id` was made. */
  madeAt(id: string): number {
    return this.#byId.get(id)!.at;
  }
  /** A derived id (reducer/duplicate.ts derivedId) by the labels of its scene and original. */
  derived(sceneId: string, originalId: string): string {
    const id = derivedId(sceneId, originalId);
    this.#byId.set(id, { label: `D(${this.#byId.get(sceneId)?.label ?? sceneId},${this.#byId.get(originalId)?.label ?? originalId})`, at: NaN });
    return id;
  }
  /** `text` with every labelled id written as its label. */
  normalize(text: string): string {
    let out = text;
    for (const [id, { label }] of this.#byId) out = out.split(id).join(`<${label}>`);
    return out;
  }
  entries(): [string, { label: string; at: number }][] {
    return [...this.#byId];
  }
}

/** Opens the twins with one Labels each. */
async function open(t: TestContext): Promise<{ pair: Twins; labels: [Labels, Labels] }> {
  // The server has run a build that keeps the gate's rows for hours, so an id made 20 minutes back is in its window.
  const pair = await openTwins(t, numberingRoom(), numberingRoom(), {}, { numberClock: STANDING_CLOCK }, { since: T0 - 120 * MINUTE });
  return { pair, labels: [new Labels(), new Labels()] };
}

/** Every frame P1's pages and the display got, raw but for history ids (Room.p1Frames), each id as its label. */
function framesOf(room: Room, labels: Labels): string[] {
  return room.p1Frames().map((f) => labels.normalize(f));
}

/** P1's and the display's frames are the same in both twins, byte for byte with each id as its label. */
function sameFrames(pair: Twins, labels: [Labels, Labels], what: string): void {
  const [a, b] = [framesOf(pair[0], labels[0]), framesOf(pair[1], labels[1])];
  const at = a.findIndex((f, i) => f !== b[i]);
  assert.ok(at < 0 && a.length === b.length, `${what}: the same frames${at < 0 ? "" : `, first apart at ${at}:\nA ${a[at]}\nB ${b[at]}`}`);
}

/**
 * The checks apart from the twins' bytes, on each twin's raw frames: every
 * id-keyed map of a snapshot is in code-unit order of its keys, and no id
 * P1 holds reads, under P1's key or no one's, within 31 minutes of when it
 * was made.
 */
function apart(room: Room, labels: Labels, what: string): void {
  for (const page of room.pages) {
    for (const frame of page.sent) {
      const f = frame as { t?: string; state?: Record<string, unknown> };
      if (f.t !== "snapshot" || !f.state) continue;
      for (const [field, value] of Object.entries(f.state)) {
        if (value === null || typeof value !== "object" || Array.isArray(value) || field === "meta") continue;
        const keys = Object.keys(value);
        assert.deepEqual(keys, [...keys].sort(), `${what}: ${room.name}: ${page.label}'s ${field} in code-unit order`);
      }
    }
  }
  const held = room.pages.map((p) => JSON.stringify(p.sent)).join("");
  for (const [id, { at }] of labels.entries()) {
    if (!held.includes(id) || Number.isNaN(at)) continue;
    assert.ok(isSealedShape(id) && !isUuidv7(id) && idTime(id) === null, `${what}: ${id} reads no time as version 7`);
    for (const [who, key] of [["P1", P1_KEY], ["no one", NOBODY]] as [string, IdKey][]) {
      const read = sealedTime(key, id);
      assert.ok(read === null || Math.abs(read - at) > 31 * MINUTE, `${what}: ${id} under ${who}'s key reads near when it was made`);
    }
  }
}

const hiddenGoblin = (id: string, at = inF(0)) => make(id, at, { name: "Goblin", visibility: "all" });

describe("twins apart only in when or in what order the DM made what P1 does not see", () => {
  test("C2, C3: a Goblin made out of sight 20 minutes back in A and now in B, then shown, gives P1 the same frames, and its id reads no time but under the DM's key", async (t) => {
    const { pair, labels } = await open(t);
    const goblins = pair.map((room, i) => labels[i]!.dm(room, "goblin", i === 0 ? 20 * MINUTE : 0));
    await each(pair, (room) => room.apply("dm", hiddenGoblin(goblins[pair.indexOf(room)]!)));
    sameFrames(pair, labels, "made");
    await each(pair, (room) => room.apply("dm", move(goblins[pair.indexOf(room)]!, inR(2))));
    sameFrames(pair, labels, "shown");
    await each(pair, (room) => room.reloadP1());
    sameFrames(pair, labels, "after a reload");
    for (const [i, room] of pair.entries()) {
      assert.ok(JSON.stringify(room.pages[0]!.sent).includes(goblins[i]!), `${room.name}: P1 holds the Goblin`);
      assert.equal(sealedTime(DM_KEY, goblins[i]!), labels[i]!.madeAt(goblins[i]!), "the DM's key reads when it was made");
      apart(room, labels[i]!, "C2");
    }
  });

  test("C4: two Goblins made out of sight in one order in A and the other in B, met together, keep the same key order, numbers and lines", async (t) => {
    const { pair, labels } = await open(t);
    const order = [["x", "y"], ["y", "x"]] as const;
    const made: Record<string, string>[] = [{}, {}];
    for (const [i, room] of pair.entries()) {
      for (const [k, label] of order[i]!.entries()) {
        made[i]![label] = labels[i]!.dm(room, label, (20 - 10 * k) * MINUTE);
        await room.apply("dm", hiddenGoblin(made[i]![label]!, inF(k)));
      }
    }
    sameFrames(pair, labels, "made");
    // Both come into sight in one batch, so the table numbers them together, by id.
    for (const [i, room] of pair.entries()) await room.queue("dm", [move(made[i]!.x!, inR(1)), move(made[i]!.y!, inR(3))]);
    sameFrames(pair, labels, "met together");
    // A reload's snapshot reads the room's maps, which hold the two in the order each twin made them.
    await each(pair, (room) => room.reloadP1());
    sameFrames(pair, labels, "after a reload");
    for (const [i, room] of pair.entries()) apart(room, labels[i]!, "C4");
  });

  test("C5: a scene copied with a Goblin out of sight, made at two times, gives P1 the same frames once the copy is shown, each derived id as its labels", async (t) => {
    const { pair, labels } = await open(t);
    const goblins = pair.map((room, i) => labels[i]!.dm(room, "goblin", i === 0 ? 20 * MINUTE : 0));
    await each(pair, (room) => room.apply("dm", hiddenGoblin(goblins[pair.indexOf(room)]!)));
    const copies = pair.map((room, i) => labels[i]!.dm(room, "copy"));
    for (const [i, room] of pair.entries()) {
      const copy = copies[i]!;
      for (const id of Object.keys(room.state.tokens)) labels[i]!.derived(copy, id);
      await room.apply("dm", { t: "scene.duplicate", sceneId: "s1", newSceneId: copy, name: "Copy", include: { creatures: true, characters: true, fog: true, drawings: false } } as Op);
      await room.apply("dm", { t: "room.setPlayerScene", sceneId: copy } as Op);
      await room.apply("dm", move(derivedId(copy, goblins[i]!), inR(2)));
    }
    sameFrames(pair, labels, "the copy shown");
    for (const [i, room] of pair.entries()) assert.ok(JSON.stringify(room.pages[0]!.sent).includes(derivedId(copies[i]!, goblins[i]!)), `${room.name}: P1 holds the Goblin's copy`);
  });

  test("C7: a group save on a Goblin out of sight, its condition made at two times, gives P1 the same frames, and each twin records the condition", async (t) => {
    const { pair, labels } = await open(t);
    const goblins = pair.map((room) => labels[pair.indexOf(room)]!.dm(room, "goblin"));
    await each(pair, (room) => room.apply("dm", hiddenGoblin(goblins[pair.indexOf(room)]!)));
    const plan = "0199f0a8-0000-7000-8000-00000000c0de";
    for (const [i, room] of pair.entries()) {
      const condition = labels[i]!.dm(room, "condition", i === 0 ? 20 * MINUTE : 0);
      await room.apply("dm", { t: "actor.outcome", plan, label: "Hold Person", targets: [{ target: { tokenId: goblins[i]! }, effects: [{ id: condition, key: "paralyzed" }] }] } as Op);
      assert.ok(pair.ids[i]!.rows.some((r) => r.id === condition), `${room.name}: the condition is recorded`);
    }
    sameFrames(pair, labels, "the save");
    await each(pair, (room) => room.apply("dm", move(goblins[pair.indexOf(room)]!, inR(2))));
    sameFrames(pair, labels, "the Goblin shown");
    for (const room of pair) assert.ok(!JSON.stringify(room.pages.map((p) => p.sent)).includes(plan), `${room.name}: the plan id never reaches P1 or the display`);
  });

  test("C6: one file imported at two times gives each player the same copy, each id as its label, and no version 7 id but member ids", () => {
    const file = numberingRoom();
    file.tokens.g = token("g", { name: "Goblin", x: 26, y: 3 });
    const copies = [T0, T0 + 6 * 60 * MINUTE].map((at) => {
      const labels = new Labels();
      let k = 0;
      const state = remapState(structuredClone(file), {
        assets: new Map(),
        newId: () => {
          const label = `import ${k++}`;
          return labels.add(sealedId(KEYS.server.key, at, nonce(label)), label, at);
        },
      });
      return { state, labels };
    });
    const read = (c: { state: RoomState; labels: Labels }) =>
      Object.values(c.state.members).flatMap((m) => (m.kind === "player" ? [c.labels.normalize(JSON.stringify(projectState(c.state, { memberId: m.id, role: "player" }, { sceneId: null })))] : []));
    const [a, b] = copies.map(read);
    assert.ok(a!.length > 0);
    assert.deepEqual(a, b);
    for (const c of copies) assert.deepEqual([...v7IdsIn(JSON.stringify(c.state))].filter((id) => !c.state.members[id]), [], "no version 7 id but member ids");
  });

  test("a chance match of a tag under P1's key comes about once in 16,384, within a seeded bound", () => {
    let matches = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) if (sealedTime(P1_KEY, sealedId(DM_KEY, T0, nonce(`count ${i}`))) !== null) matches++;
    // 50,000 / 16,384 is about 3. The bound holds for these fixed nonces, and a fresh key's would rarely pass 12.
    assert.ok(matches <= 12, `${matches} chance matches in ${n}`);
  });
});
