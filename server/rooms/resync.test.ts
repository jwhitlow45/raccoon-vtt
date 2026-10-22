import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { keys } from "#shared/keys.ts";
import { CHARACTER_CHANGED } from "#shared/limits.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Actor, Character, DdbSync, Member, PcStats, RoomState } from "#shared/model.ts";
import { expectOf } from "#shared/permissions.ts";
import { EXPECT_PARTS, SYNC_AT_AHEAD, type CharacterPatch, type ExpectPart, type Op, type PcStatsPatch, type ServerMessage } from "#shared/protocol.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor as testActor, character as testCharacter, effect as testEffect } from "#shared/testutil.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import type { Pool } from "./persistence.ts";

/**
 * The re-sync's race at the room actor (docs/design-v1-resync.md 4 and 5):
 * an Apply or an Undo carries `expect`, a hash of each part it writes as
 * its sender saw it, and the server refuses it when the character changed
 * in between, whoever changed it. The patches are built here by hand, as
 * the dialog builds them, and each device's copy is read from what its
 * socket was sent.
 */

/** What the room's rows answer: one snapshot, no ops, and every commit taken. */
class FakeDb {
  #durableMax = 0;
  #staged: number[] = [];
  #frozen = false;
  readonly #state: RoomState;
  readonly #dmGrants: string[];

  constructor(state: RoomState, dmGrants: string[]) {
    this.#state = state;
    this.#dmGrants = dmGrants;
  }

  /** Parks every later statement, so a failed test leaves no timer behind. */
  freeze(): void {
    this.#frozen = true;
  }

  pool(): Pool {
    const run = (sql: string, params: unknown[] = []) => {
      if (this.#frozen) return new Promise(() => undefined);
      return Promise.resolve().then(() => this.#answer(sql.trim(), params));
    };
    return {
      query: run,
      connect: () => (this.#frozen ? new Promise(() => undefined) : Promise.resolve({ query: run, release: () => undefined })),
    } as unknown as Pool;
  }

  #answer(sql: string, params: unknown[]): { rows: unknown[]; rowCount?: number } {
    if (sql.includes("from room_snapshots")) return { rows: [{ seq: "0", state: this.#state, schema_version: SNAPSHOT_VERSION }] };
    if (sql.includes("max(seq)")) return { rows: [{ max: String(this.#durableMax) }] };
    if (sql.includes("from room_ops")) return { rows: [] };
    if (sql.includes("from grants")) return { rows: this.#dmGrants.map((member_id) => ({ member_id })) };
    if (sql.startsWith("insert into room_ops")) {
      this.#staged = params[1] as number[];
      return { rows: [] };
    }
    if (sql === "commit") {
      this.#durableMax = Math.max(this.#durableMax, ...this.#staged);
      this.#staged = [];
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }
}

const ROOM = "RESYNC00";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function member(name: string, kind: Member["kind"]): Member {
  return { id: uuidv7(), rev: 0, name, color: "#336699", kind, createdAt: new Date().toISOString() };
}

function within<T>(ms: number, work: Promise<T>): Promise<T | "stuck"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"stuck">((resolve) => {
    timer = setTimeout(() => resolve("stuck"), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type Ev = Extract<ServerMessage, { t: "ev" }>;

/** The batch that answered op `n`. */
async function evOf(sent: ServerMessage[], n: number): Promise<Ev> {
  const found = () => sent.find((m): m is Ev => m.t === "ev" && ((m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false)));
  const ev = await within(
    2_000,
    (async () => {
      for (;;) {
        const hit = found();
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 5));
      }
    })(),
  );
  assert.ok(ev !== "stuck", `op ${n} got no answer`);
  return ev;
}

/** One device: its socket, what it was sent, and its op numbers. */
type Device = {
  conn: Connection;
  sent: ServerMessage[];
  /** Sends the op and waits for its answer: null when taken, else the refusal. */
  send(op: Op): Promise<{ code: string; message: string } | null>;
  /** Sends the op without waiting, and gives its number. */
  post(op: Op): Promise<number>;
  /** The character as this device holds it now, from the snapshot and every batch since. */
  sees(characterId: string): Character;
};

function device(actor: RoomActor, who: Member, role: "dm" | "player"): Device {
  const sent: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: ROOM, memberId: who.id, role }, "203.0.113.9");
  actor.attach(conn);
  let n = 0;
  const post = async (op: Op) => {
    n += 1;
    await actor.op(conn, n, op);
    return n;
  };
  return {
    conn,
    sent,
    post,
    async send(op) {
      const at = await post(op);
      const refusal = (await evOf(sent, at)).rejects?.find((r) => r.n === at);
      return refusal ? { code: refusal.code, message: refusal.message } : null;
    },
    sees(characterId) {
      const key = keys.character(characterId);
      let value: unknown;
      for (const m of sent) {
        if (m.t === "snapshot") value = (m.state as { characters: Record<string, unknown> }).characters[characterId];
        else if (m.t === "ev") for (const c of m.changes) if (c.key === key) value = "deleted" in c ? undefined : c.value;
      }
      assert.ok(value, "the device holds the character");
      return structuredClone(value) as Character;
    },
  };
}

const BLOCK: PcStats = {
  ...structuredClone(EMPTY_PC_STATS as PcStats),
  abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 16, cha: 10 },
  saves: ["int", "wis"],
  spellAbility: "cha",
};

/** A sync's record as Apply sends it: no `at`, which the server writes. */
const SYNCED = { from: "123456789", base: { abilities: { ...BLOCK.abilities, wis: 18 }, spellAbility: "wis" as const, level: 6, ac: 16, hpMax: 45 }, rolls: {} };

/** A re-sync's Apply: Wisdom 18 and Wisdom as the casting ability, level 6, AC 16 and a maximum of 45. */
const APPLY: CharacterPatch = {
  stats: { abilities: SYNCED.base.abilities, spellAbility: "wis" },
  level: 6,
  actor: { ac: 16, hp: { max: 45 } },
  ddbSync: SYNCED,
};

/** A record an earlier sync left. */
const EARLIER: DdbSync = { at: "2026-10-01T18:00:00.000Z", from: "123456789", base: { abilities: BLOCK.abilities, spellAbility: "cha", level: 5, ac: 15, hpMax: 38 }, rolls: {} };

/** A DM, Ana, and Bree, whom Ana plays: level 5, AC 15, 35 of 38 HP, with a typed block. */
function table(bree: Partial<Omit<Character, "actor">> & { actor?: Partial<Actor> } = {}): { state: RoomState; dm: Member; ana: Member; id: string } {
  const dm = member("DM", "dm");
  const ana = member("Ana", "player");
  const state = createInitialState({ roomName: "Re-sync", dm });
  state.members[ana.id] = ana;
  const id = uuidv7();
  const { actor: own, ...rest } = bree;
  state.characters[id] = testCharacter(id, {
    name: "Bree",
    ownerIds: [ana.id],
    level: 5,
    stats: BLOCK,
    ...rest,
    actor: testActor({ ac: 15, hp: { cur: 35, max: 38, temp: 0 }, initBonus: 2, passivePerception: 13, dmNotes: "", ...own }),
  });
  return { state, dm, ana, id };
}

async function play(
  setup: ReturnType<typeof table>,
  run: (room: { actor: RoomActor; dm: Device; ana: Device; id: string }) => Promise<void>,
  options: Partial<ActorDeps["options"]> = {},
): Promise<void> {
  const db = new FakeDb(setup.state, [setup.dm.id]);
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: ROOM, pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget(),
    gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, ...options },
  });
  assert.ok(actor);
  try {
    const dm = device(actor, setup.dm, "dm");
    const ana = device(actor, setup.ana, "player");
    await actor.hello(dm.conn, { clientId: "c1", resumeFrom: 1 });
    await actor.hello(ana.conn, { clientId: "c2", resumeFrom: 1 });
    await run({ actor, dm, ana, id: setup.id });
  } finally {
    db.freeze();
    void actor.shutdown({ code: 1012, snapshot: false });
  }
}

/** The parts a patch writes, as `expect` names them, and the shape, which every Apply and Undo sends. */
function partsOf(patch: CharacterPatch): ExpectPart[] {
  const parts: ExpectPart[] = Object.keys(patch.stats ?? {}).map((part) => `stats.${part}` as ExpectPart);
  if (patch.level !== undefined) parts.push("level");
  if (patch.name !== undefined) parts.push("name");
  for (const part of ["ac", "speeds", "senses", "sheetUrl", "hp"] as const) if (patch.actor?.[part] !== undefined) parts.push(`actor.${part}`);
  if (patch.ddbSync !== undefined) parts.push("ddbSync");
  parts.push("actor.shape");
  return parts;
}

/** The op the dialog sends: the patch, and `expect` over what it writes as the sender's copy holds it. */
function update(id: string, seen: Character, patch: CharacterPatch, parts: Iterable<ExpectPart> = partsOf(patch)): Op {
  return { t: "character.update", characterId: id, patch, expect: expectOf(seen, parts) };
}

/** The Undo of a patch: each part it wrote as the character held it before, HP as its current and maximum, and the record before or none. */
function undoOf(before: Character, patch: CharacterPatch): CharacterPatch {
  const out: CharacterPatch = {};
  if (patch.stats) out.stats = Object.fromEntries(Object.keys(patch.stats).map((part) => [part, before.stats?.[part as keyof PcStats] ?? null])) as PcStatsPatch;
  if (patch.level !== undefined) out.level = before.level ?? null;
  if (patch.actor) {
    out.actor = {};
    if (patch.actor.ac !== undefined) out.actor.ac = before.actor.ac;
    if (patch.actor.hp !== undefined) out.actor.hp = { cur: before.actor.hp.cur, max: before.actor.hp.max };
  }
  if (patch.ddbSync !== undefined) out.ddbSync = before.ddbSync ?? null;
  return out;
}

/**
 * What a patch makes of the character before it, as the dialog works it out
 * for its Undo: the parts as sent, the current HP cut to a lower maximum,
 * and the record with the server's `at`. Never the view at the answer,
 * which may already hold a later edit from the same batch.
 */
function resultOf(before: Character, patch: CharacterPatch, at: string): Character {
  const out = structuredClone(before);
  const stats = out.stats as Record<string, unknown> | undefined;
  for (const [part, value] of Object.entries(patch.stats ?? {})) {
    if (value === null) delete stats?.[part];
    else if (stats) stats[part] = value;
  }
  if (patch.level === null) delete out.level;
  else if (patch.level !== undefined) out.level = patch.level;
  if (patch.actor?.ac !== undefined) out.actor.ac = patch.actor.ac;
  if (patch.actor?.hp) {
    const max = patch.actor.hp.max ?? out.actor.hp.max;
    out.actor.hp = { ...out.actor.hp, max, cur: Math.min(max, patch.actor.hp.cur ?? out.actor.hp.cur) };
  }
  if (patch.ddbSync === null) delete out.ddbSync;
  else if (patch.ddbSync) out.ddbSync = { ...patch.ddbSync, at: patch.ddbSync.at ?? at };
  return out;
}

/** The server's `at` on the record a device was sent, once that record is the one the Apply sent. */
function confirmedAt(seen: Character, sent: CharacterPatch["ddbSync"]): string {
  assert.ok(seen.ddbSync && sent);
  const { at, ...record } = seen.ddbSync;
  assert.deepEqual(record, sent, "the confirmed record is the one sent, apart from its at");
  return at;
}

const STALE = { code: "invalid", message: CHARACTER_CHANGED };
const setAc = (id: string, ac: number): Op => ({ t: "character.update", characterId: id, patch: { actor: { ac } } });

describe("a re-sync's race at the room actor (docs/design-v1-resync.md 5)", () => {
  test("the DM's AC edit between Ana's review and her Apply refuses it and changes nothing, and the review rebuilt from the live character is taken", async () => {
    await play(table(), async ({ actor, dm, ana, id }) => {
      const review = ana.sees(id);
      assert.deepEqual(expectOf(review, EXPECT_PARTS), expectOf(actor.committed.state.characters[id]!, EXPECT_PARTS), "Ana's copy hashes as the server's");
      assert.equal(await dm.send(setAc(id, 17)), null);
      const before = structuredClone(actor.committed.state.characters[id]);
      assert.deepEqual(await ana.send(update(id, review, APPLY)), STALE);
      assert.deepEqual(actor.committed.state.characters[id], before, "nothing changed");
      // The rebuilt review lists the DM's AC as a change made here, which the Apply keeps.
      const rebuilt = ana.sees(id);
      assert.equal(rebuilt.actor.ac, 17);
      const kept: CharacterPatch = { ...APPLY, actor: { hp: { max: 45 } } };
      assert.equal(await ana.send(update(id, rebuilt, kept)), null);
      const bree = actor.committed.state.characters[id]!;
      assert.equal(bree.level, 6);
      assert.equal(bree.stats?.abilities.wis, 18);
      assert.equal(bree.stats?.spellAbility, "wis");
      assert.equal(bree.actor.ac, 17);
      assert.deepEqual(bree.actor.hp, { cur: 35, max: 45, temp: 0 });
      confirmedAt(ana.sees(id), SYNCED);
    });
  });

  test("the DM's AC edit after Ana's Apply refuses her Undo and changes nothing, and an Undo over the live character is taken", async () => {
    await play(table(), async ({ actor, dm, ana, id }) => {
      const review = ana.sees(id);
      assert.equal(await ana.send(update(id, review, APPLY)), null);
      const result = resultOf(review, APPLY, confirmedAt(ana.sees(id), SYNCED));
      assert.deepEqual(expectOf(result, EXPECT_PARTS), expectOf(actor.committed.state.characters[id]!, EXPECT_PARTS), "the worked-out result hashes as the server's");
      assert.equal(await dm.send(setAc(id, 17)), null);
      const before = structuredClone(actor.committed.state.characters[id]);
      const undo = undoOf(review, APPLY);
      assert.equal(undo.ddbSync, null, "Bree had no record before");
      assert.deepEqual(await ana.send(update(id, result, undo)), STALE);
      assert.deepEqual(actor.committed.state.characters[id], before, "nothing changed");
      assert.equal(await ana.send(update(id, ana.sees(id), undo)), null);
      const bree = actor.committed.state.characters[id]!;
      assert.deepEqual(bree.stats, BLOCK);
      assert.equal(bree.level, 5);
      assert.equal(bree.actor.ac, 15);
      assert.deepEqual(bree.actor.hp, { cur: 35, max: 38, temp: 0 });
      assert.equal("ddbSync" in bree, false);
    });
  });

  test("Ana's level edit between the DM's review and the DM's own Apply refuses it and changes nothing, and the rebuilt Apply is taken", async () => {
    await play(table(), async ({ actor, dm, ana, id }) => {
      const review = dm.sees(id);
      assert.equal(review.actor.dmNotes, "", "the DM's copy is whole");
      assert.equal(await ana.send({ t: "character.update", characterId: id, patch: { level: 7 } }), null);
      const before = structuredClone(actor.committed.state.characters[id]);
      assert.deepEqual(await dm.send(update(id, review, APPLY)), STALE);
      assert.deepEqual(actor.committed.state.characters[id], before, "nothing changed");
      const { level: _level, ...kept } = APPLY;
      assert.equal(await dm.send(update(id, dm.sees(id), kept)), null);
      assert.equal(actor.committed.state.characters[id]!.level, 7);
      assert.equal(actor.committed.state.characters[id]!.actor.ac, 16);
    });
  });

  test("the DM's deletion of Bree's block between Ana's review and her Apply refuses it, and no default block comes back (RSBUILD-ASTRA-03)", async () => {
    // A block with no casting ability and no record, so the Apply's parts were absent before the deletion too.
    const { spellAbility: _spell, ...plain } = BLOCK;
    await play(table({ stats: plain }), async ({ actor, dm, ana, id }) => {
      const review = ana.sees(id);
      assert.equal(await dm.send({ t: "character.update", characterId: id, patch: { stats: null } }), null);
      const before = structuredClone(actor.committed.state.characters[id]);
      assert.equal(before?.stats, undefined);
      assert.deepEqual(await ana.send(update(id, review, { stats: { spellAbility: "wis" }, ddbSync: SYNCED })), STALE);
      assert.deepEqual(await ana.send(update(id, review, { actor: { ac: 16 }, ddbSync: SYNCED })), STALE, "a record with no block part is refused too");
      assert.deepEqual(actor.committed.state.characters[id], before, "nothing changed");
    });
  });

  test("a shape taken between the review and Apply refuses it, though the AC it leaves is the same", async () => {
    await play(table(), async ({ actor, dm, ana, id }) => {
      const review = ana.sees(id);
      assert.equal(await dm.send({ t: "character.update", characterId: id, patch: { actor: { srdId: "brown-bear", wildShape: true } } }), null);
      const shaped = ana.sees(id);
      assert.equal(shaped.actor.ac, 15);
      assert.deepEqual(expectOf(shaped, ["actor.ac"]), expectOf(review, ["actor.ac"]));
      const before = structuredClone(actor.committed.state.characters[id]);
      assert.deepEqual(await ana.send(update(id, review, APPLY)), STALE);
      assert.deepEqual(actor.committed.state.characters[id], before);
      // The same Apply without its AC, which a shape keeps out of the merge, still names the shape.
      const { actor: _actor, ...withoutActor } = APPLY;
      assert.deepEqual(await ana.send(update(id, review, withoutActor)), STALE);
    });
  });

  test("an AC edit published in one batch with Ana's Apply refuses her Undo, whose expect holds Apply's AC", async () => {
    await play(
      table(),
      async ({ actor, dm, ana, id }) => {
        const review = ana.sees(id);
        const applied = await ana.post(update(id, review, APPLY));
        const edited = await dm.post(setAc(id, 17));
        const answer = await evOf(ana.sent, applied);
        assert.equal(answer.rejects, undefined);
        assert.ok((await evOf(dm.sent, edited)).acks?.includes(edited));
        // The answer's batch already holds the DM's later edit, so the device's view at the answer is not Apply's result.
        const atAnswer = answer.changes.find((c) => c.key === keys.character(id));
        assert.ok(atAnswer && "value" in atAnswer);
        assert.equal((atAnswer.value as Character).actor.ac, 17);
        const result = resultOf(review, APPLY, confirmedAt(ana.sees(id), SYNCED));
        assert.equal(result.actor.ac, 16);
        const before = structuredClone(actor.committed.state.characters[id]);
        assert.deepEqual(await ana.send(update(id, result, undoOf(review, APPLY))), STALE);
        assert.deepEqual(actor.committed.state.characters[id], before);
      },
      // Long enough that both ops are staged before the batch commits.
      { batchMs: 50 },
    );
  });

  test("Apply's answer gives the at the server wrote, and the DM's later sync of an equal record refuses Ana's Undo built on it (RS-SOL-1)", async () => {
    let now = Date.parse("2026-10-21T19:00:00.000Z");
    await play(
      table(),
      async ({ actor, dm, ana, id }) => {
        const review = ana.sees(id);
        const applied = await ana.post(update(id, review, APPLY));
        const answer = await evOf(ana.sent, applied);
        const at = actor.committed.state.characters[id]!.ddbSync!.at;
        assert.equal(at, "2026-10-21T19:00:00.000Z");
        assert.deepEqual(answer.stamped, [{ n: applied, at }]);
        assert.equal(dm.sent.some((m) => m.t === "ev" && m.stamped !== undefined), false, "only the sender hears it");
        const result = resultOf(review, APPLY, at);
        const undo = undoOf(review, APPLY);
        // The DM syncs the same record a minute later and takes Bree's saves back to D&D Beyond's, a part Ana's Apply never wrote.
        now += 60_000;
        const later: CharacterPatch = { stats: { saves: ["wis"] }, ddbSync: SYNCED };
        assert.equal(await dm.send(update(id, dm.sees(id), later)), null);
        assert.equal(actor.committed.state.characters[id]!.ddbSync!.at, "2026-10-21T19:01:00.000Z");
        const before = structuredClone(actor.committed.state.characters[id]);
        assert.deepEqual(await ana.send(update(id, result, undo)), STALE);
        assert.deepEqual(actor.committed.state.characters[id], before, "the DM's sync stands");
      },
      { now: () => now },
    );
  });

  test("the DM's equal sync in the same millisecond as Ana's Apply gets its own stamp, and refuses Ana's Undo (RSBUILD-ASTRA-04)", async () => {
    const now = Date.parse("2026-10-21T19:00:00.000Z");
    await play(
      table(),
      async ({ actor, dm, ana, id }) => {
        const review = ana.sees(id);
        const applied = await ana.post(update(id, review, APPLY));
        const answer = await evOf(ana.sent, applied);
        assert.deepEqual(answer.stamped, [{ n: applied, at: "2026-10-21T19:00:00.000Z" }]);
        const later: CharacterPatch = { stats: { saves: ["wis"] }, ddbSync: SYNCED };
        const synced = await dm.post(update(id, dm.sees(id), later));
        assert.deepEqual((await evOf(dm.sent, synced)).stamped, [{ n: synced, at: "2026-10-21T19:00:00.001Z" }], "the clock has not moved, the stamp has");
        const before = structuredClone(actor.committed.state.characters[id]);
        assert.deepEqual(await ana.send(update(id, resultOf(review, APPLY, "2026-10-21T19:00:00.000Z"), undoOf(review, APPLY))), STALE);
        assert.deepEqual(actor.committed.state.characters[id], before, "the DM's sync stands");
      },
      { now: () => now },
    );
  });

  test("a record Ana sends with an at from the future is refused and changes nothing, and one a day ahead exactly is taken (RS-O-37)", async () => {
    const now = Date.parse("2026-10-21T19:00:00.000Z");
    await play(
      table({ ddbSync: EARLIER }),
      async ({ actor, ana, id }) => {
        const before = structuredClone(actor.committed.state.characters[id]);
        const refused = await ana.send({ t: "character.update", characterId: id, patch: { ddbSync: { ...SYNCED, at: "9999-12-31T23:59:59.999Z" } } });
        assert.deepEqual(refused, { code: "invalid", message: SYNC_AT_AHEAD });
        assert.deepEqual(await ana.send({ t: "character.update", characterId: id, patch: { ddbSync: { ...SYNCED, at: "2026-10-22T19:00:00.001Z" } } }), { code: "invalid", message: SYNC_AT_AHEAD });
        assert.deepEqual(actor.committed.state.characters[id], before, "nothing changed");
        assert.equal(await ana.send({ t: "character.update", characterId: id, patch: { ddbSync: { ...SYNCED, at: "2026-10-22T19:00:00.000Z" } } }), null);
        assert.equal(actor.committed.state.characters[id]!.ddbSync!.at, "2026-10-22T19:00:00.000Z");
      },
      { now: () => now },
    );
  });

  test("Ana's Apply on a character with a DM's note and a hidden effect is taken, though the DM changes both after her review", async () => {
    const setup = table({ actor: { dmNotes: "owes the thieves' guild", effects: [testEffect("hex", { hiddenFromPlayers: true })] } });
    await play(setup, async ({ actor, dm, ana, id }) => {
      const review = ana.sees(id);
      assert.equal(review.actor.dmNotes, undefined);
      assert.deepEqual(review.actor.effects, []);
      assert.equal(await dm.send({ t: "character.update", characterId: id, patch: { actor: { dmNotes: "is the guild's spy" } } }), null);
      assert.equal(await dm.send({ t: "actor.effect.add", target: { characterId: id }, effect: { id: "mark", key: "blessed", hiddenFromPlayers: true } }), null);
      assert.equal(await ana.send(update(id, review, APPLY, EXPECT_PARTS)), null, "every part a player can name");
      const bree = actor.committed.state.characters[id]!;
      assert.equal(bree.level, 6);
      assert.equal(bree.actor.dmNotes, "is the guild's spy");
      assert.deepEqual(bree.actor.effects.map((e) => e.id), ["hex", "mark"]);
    });
  });

  test("a sync to a maximum of 30 takes Bree from 35 of 38 to 30 of 30, and its Undo gives back 35 of 38 and the record before", async () => {
    await play(table({ ddbSync: EARLIER }), async ({ actor, ana, id }) => {
      const review = ana.sees(id);
      const lower: CharacterPatch = { actor: { hp: { max: 30 } }, ddbSync: { ...SYNCED, base: { ...SYNCED.base, hpMax: 30 } } };
      assert.equal(await ana.send(update(id, review, lower)), null);
      assert.deepEqual(actor.committed.state.characters[id]!.actor.hp, { cur: 30, max: 30, temp: 0 });
      const result = resultOf(review, lower, confirmedAt(ana.sees(id), lower.ddbSync));
      assert.deepEqual(result.actor.hp, { cur: 30, max: 30, temp: 0 }, "the device works out the cut as the reducer makes it");
      const undo = undoOf(review, lower);
      assert.deepEqual(undo, { actor: { hp: { cur: 35, max: 38 } }, ddbSync: EARLIER });
      assert.equal(await ana.send(update(id, result, undo)), null);
      const bree = actor.committed.state.characters[id]!;
      assert.deepEqual(bree.actor.hp, { cur: 35, max: 38, temp: 0 });
      assert.deepEqual(bree.ddbSync, EARLIER, "the record before, its at kept");
    });
  });
});
