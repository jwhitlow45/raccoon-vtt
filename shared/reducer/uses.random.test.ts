import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp, type DiceOp } from "../dice/resolve.ts";
import { LIMITS } from "../limits.ts";
import type { Actor, PromptKey, RoomState, Settled, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { stableStringify } from "../project.ts";
import { opSchema, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, actor, chance, character, combatUseOp, env, int, pick, rng, room, token } from "../testutil.ts";
import { hpUndoRestore } from "./hpUndo.ts";

/**
 * Random sequences of what combat uses juggle (docs/design-v1-combat-controls.md
 * 11): spends and give backs of every kind, prompts settled from every
 * surface, Skip and Reopen, rolls, take backs, turn starts by Next and by
 * removal with a mount and a companion, Previous, rests, In lair and block
 * changes. After every op the invariants hold:
 *
 * - every count is within its bounds: a mark's `used` 1 to its `max`, a
 *   resource's 0 to its `max`, pips and Resistance at most their counts;
 * - a creature holds at most `LIMITS.usesPerActor` marks;
 * - no occurrence is settled twice, and none after its turn;
 * - Next then Previous puts back every record, mark, damage type and pip;
 * - nothing a Long Rest brings back survives it;
 * - replaying the stored ops from the room's first state, its maps in
 *   another key order, rebuilds the same room.
 */

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };

/** A dragon, a troll, Thorn (dying now and then, with resources) and his shared wolf, Bree on a warhorse, and a goblin. */
function start(): RoomState {
  const state = room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", x: 20, y: 5, actor: { inline: actor({ srdId: "adult-red-dragon", hp: { cur: 200, max: 256, temp: 0 }, legendary }) } }),
      troll: token("troll", { name: "Troll", x: 14, y: 14, actor: { inline: actor({ hp: { cur: 60, max: 94, temp: 0 } }) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 10, y: 10, actor: { ref: "thorn" } }),
      wolf: token("wolf", { kind: "npc", name: "Wolf", x: 11, y: 10, ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor({ legendary: { actionsMax: 1, actionsUsed: 0, resistMax: 0, resistUsed: 0 } }) } }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ legendary: { actionsMax: 2, actionsUsed: 0, resistMax: 1, resistUsed: 0 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 5, y: 4, ownerIds: ["p2"], attached: { to: "horse", kind: "ride", steer: true } }),
      gob: token("gob", { name: "Goblin", x: 25, y: 20 }),
    },
    characters: {
      thorn: character("thorn", {
        name: "Thorn",
        ownerIds: ["p1"],
        actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying" }),
        resources: [
          { id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" },
          { id: "loh", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true },
        ],
      }),
    },
  });
  state.meta.settings = { ...state.meta.settings, monstersDieAtZero: false, skipDefeated: false };
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: null,
    entries: [
      { id: "ed", tokenId: "dragon", value: 20, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
      { id: "et", tokenId: "thorn", value: 15, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
      { id: "er", tokenId: "troll", value: 12, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
      { id: "eb", tokenId: "bree", value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
      { id: "eh", tokenId: "horse", value: 8, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
      { id: "eg", tokenId: "gob", value: 5, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
    ],
  };
  return state;
}

const CREATURES = ["dragon", "troll", "thorn", "wolf", "horse", "gob"] as const;
const ROWS: Record<string, string> = { dragon: "ed", thorn: "et", troll: "er", bree: "eb", horse: "eh", gob: "eg" };

/** Every actor of the room, by holder, for comparing and checking. */
function actors(state: RoomState): [string, Actor][] {
  const out: [string, Actor][] = Object.values(state.characters).map((c) => [`character:${c.id}`, c.actor]);
  for (const t of Object.values(state.tokens)) if ("inline" in t.actor) out.push([`token:${t.id}`, t.actor.inline]);
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

function actorOf(state: RoomState, tokenId: string): Actor | undefined {
  const t = state.tokens[tokenId];
  if (!t) return undefined;
  return "inline" in t.actor ? t.actor.inline : state.characters[t.actor.ref]?.actor;
}

/** A map with its keys in reverse order, all the way down, as a jsonb round trip may hand it back. */
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)]));
}

/** The prompt an op settles, if any, with whether it reopens instead. */
function settles(op: Op): { tokenId: string; record: number; what: PromptKey; reopen: boolean } | null {
  const of = (target: { tokenId?: string; characterId?: string }) => target.tokenId ?? "thorn";
  if (op.t === "actor.prompt") return { tokenId: of(op.target), record: op.record, what: op.what as PromptKey, reopen: op.state === "open" };
  if (op.t === "sys.dice" && (op.asked.t === "actor.deathRoll" || op.asked.t === "actor.rechargeRoll") && op.asked.record !== undefined) {
    return { tokenId: of(op.asked.target), record: op.asked.record, what: op.asked.t === "actor.deathRoll" ? "deathSave" : `recharge:${op.asked.key}`, reopen: false };
  }
  if (op.t === "actor.use" && op.use.kind === "regenerate") return { tokenId: of(op.target), record: op.use.record, what: "regeneration", reopen: false };
  return null;
}

function step(r: () => number, state: RoomState, n: number): { op: Op; who: Viewer } | null {
  const who: Viewer = chance(r, 0.2) ? P1 : DM;
  const target = () => (chance(r, 0.15) ? { characterId: "thorn" } : { tokenId: pick(r, CREATURES) });
  // The creatures whose turn runs now, whose prompts are open: most answers go to them, the rest test the refusals.
  const running = ["dragon", "troll", "thorn", "wolf", "horse"].filter((id) => {
    const rec = actorOf(state, id)?.turnRecord;
    return rec !== undefined && rec.entryId === state.encounter?.activeEntryId && rec.round === state.encounter.round;
  });
  const whose = (ids: readonly string[]) => (running.length > 0 && chance(r, 0.75) ? pick(r, running) : pick(r, ids));
  const recordOf = (id: string) => {
    const current = actorOf(state, id)?.turnRecord?.id;
    // Now and then an old or a made up record, which must be refused.
    return current !== undefined && chance(r, 0.85) ? current : int(r, 0, n + 2);
  };
  const roll = (op: DiceOp) => {
    const permitted = canApply(op, who, state, { canUseAsset: () => true });
    if (!permitted.ok) return null;
    const face = int(r, 1, 20);
    const resolved = resolveDiceOp(op, state, { draw: (sides) => Math.min(sides, face), batch: "AbCdEfGhIjKlMnOp" });
    return resolved.ok ? { op: resolved.op as Op, who } : null;
  };
  switch (int(r, 0, 17)) {
    case 0:
    case 1:
      return { op: { t: "encounter.next" }, who: DM };
    case 2:
      return { op: { t: "encounter.prev" }, who: DM };
    case 3:
    case 4:
      return { op: combatUseOp(r, target), who };
    case 5: {
      const id = whose(["thorn", "dragon"]);
      return roll({ t: "actor.deathRoll", tag: `d${n}`, target: { tokenId: id }, ...(chance(r, 0.8) ? { record: recordOf(id) } : {}) });
    }
    case 6: {
      const id = whose(["dragon", "horse", "wolf"]);
      return roll({ t: "actor.rechargeRoll", tag: `r${n}`, target: { tokenId: id }, key: "actions:fire-breath", name: "Fire Breath", min: int(r, 4, 6), ...(chance(r, 0.8) ? { record: recordOf(id) } : {}) });
    }
    case 7: {
      const id = whose(["troll", "thorn", "wolf"]);
      return { op: { t: "actor.use", target: { tokenId: id }, use: { kind: "regenerate", key: "traits:regeneration", amount: int(r, 1, 15), record: recordOf(id) } }, who };
    }
    case 8: {
      const id = whose(["troll", "thorn", "dragon", "horse"]);
      const what = pick(r, ["regeneration", "deathSave", "recharge:actions:fire-breath"]);
      return { op: { t: "actor.prompt", target: { tokenId: id }, record: recordOf(id), what, state: chance(r, 0.6) ? "skipped" : "open" }, who };
    }
    case 9: {
      const types = pick(r, [["fire"], ["acid", "slashing"], ["cold"]] as const);
      return { op: { t: "actor.hp", target: target(), change: { kind: "damage", amount: int(r, 0, 12), types: [...types] } }, who: DM };
    }
    case 10:
      return { op: { t: "actor.hp", target: target(), change: { kind: "heal", amount: int(r, 1, 12) } }, who: DM };
    case 11: {
      const lines = state.log.filter((e) => e.data?.type === "hp" && e.data.revert !== undefined);
      const line = lines.length > 0 ? pick(r, lines) : undefined;
      const built = line ? hpUndoRestore(state, line.id) : undefined;
      return line && built?.ok ? { op: { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: line.id }, who: DM } : null;
    }
    case 12: {
      const active = state.encounter?.activeEntryId;
      if (!active) return null;
      return { op: { t: "encounter.remove", entryIds: [active] }, who: DM };
    }
    case 13: {
      const missing = Object.entries(ROWS).filter(([id, row]) => state.tokens[id] && !state.encounter?.entries.some((e) => e.id === row || e.tokenId === id));
      if (missing.length === 0) return null;
      const [id] = pick(r, missing);
      return { op: { t: "encounter.add", entries: [{ id: `${ROWS[id]}-${n}`, tokenId: id, value: int(r, 1, 20) }] }, who: DM };
    }
    case 14:
      return { op: chance(r, 0.5) ? { t: "actor.rest", target: target(), kind: "long" } : { t: "actor.rest", target: target(), kind: "short", heal: int(r, 0, 5) }, who: DM };
    case 15: {
      const row = pick(r, ["ed", "eh"]);
      return { op: { t: "encounter.update", entryId: row, patch: { inLair: chance(r, 0.5) }, counts: { actionsMax: int(r, 1, 4), resistMax: int(r, 0, 4) } }, who: DM };
    }
    case 16:
      return { op: { t: "token.update", tokenId: pick(r, ["dragon", "horse"]), patch: { actor: { srdId: pick(r, ["adult-red-dragon", "young-red-dragon", null]) } } }, who: DM };
    default:
      return { op: { t: "actor.hp", target: { characterId: "thorn" }, change: { kind: "set", cur: 0 } }, who: DM };
  }
}

function checkBounds(state: RoomState, at: string): void {
  for (const [holder, a] of actors(state)) {
    const marks = Object.values(a.uses ?? {});
    assert.ok(marks.length <= LIMITS.usesPerActor, `${at} ${holder}: ${marks.length} marks`);
    for (const m of marks) assert.ok(m.used >= 1 && m.used <= m.max, `${at} ${holder}: mark ${m.name} ${m.used} of ${m.max}`);
    if (a.legendary) {
      assert.ok(a.legendary.actionsUsed >= 0 && a.legendary.actionsUsed <= a.legendary.actionsMax, `${at} ${holder}: pips`);
      assert.ok(a.legendary.resistUsed >= 0 && a.legendary.resistUsed <= a.legendary.resistMax, `${at} ${holder}: Resistance`);
    }
  }
  for (const c of Object.values(state.characters)) for (const res of c.resources ?? []) assert.ok(res.used >= 0 && res.used <= res.max, `${at} ${c.id}: ${res.name}`);
}

/** What Next then Previous must put back: every record, mark, damage type and pip. */
function turnState(state: RoomState): string {
  return stableStringify(actors(state).map(([holder, a]) => [holder, a.turnRecord ?? null, a.uses ?? null, a.hurt ?? null, a.legendary?.actionsUsed ?? null]));
}

function run(seed: number, steps: number): { applied: number; settled: number; refused: number } {
  const r = rng(seed);
  const first = start();
  let state = first;
  const stored: { op: Op; who: Viewer; seq: number }[] = [];
  /** Each occurrence's last answer, by holder, record and prompt. */
  const answers = new Map<string, Settled["state"]>();
  let applied = 0;
  let settled = 0;
  let refused = 0;
  for (let i = 0; i < steps; i++) {
    const seq = 100 + i;
    const drawn = step(r, state, seq);
    if (!drawn) continue;
    const { op, who } = drawn;
    const parsed = opSchema.safeParse(op);
    assert.ok(parsed.success, `seed ${seed} step ${i}: the generator made an invalid ${op.t}`);
    const prompt = settles(op);
    const before = prompt ? actorOf(state, prompt.tokenId) : undefined;
    const current = before?.turnRecord !== undefined && state.encounter?.activeEntryId === before.turnRecord.entryId && state.encounter.round === before.turnRecord.round && before.turnRecord.id === prompt?.record;
    const result = applyOp(state, op, who, env(seq));
    if (!result.ok) {
      refused++;
      continue;
    }
    applied++;
    stored.push({ op, who, seq });
    const at = `seed ${seed} step ${i} (${op.t})`;
    if (prompt) {
      const after = actorOf(result.state, prompt.tokenId)?.turnRecord?.settled?.[prompt.what];
      const key = `${prompt.tokenId}:${prompt.record}:${prompt.what}`;
      const was = answers.get(key);
      if (prompt.reopen) {
        if (after === undefined) answers.delete(key);
      } else {
        assert.ok(current, `${at}: settled after its turn`);
        assert.notEqual(was, "done", `${at}: ${key} settled twice`);
        assert.ok(after, `${at}: an accepted answer settles its prompt`);
        answers.set(key, after.state);
        settled++;
      }
    }
    // A take back of a Regeneration heal reopens its prompt, which may then be answered again.
    if (op.t === "sys.restore") {
      for (const [key] of answers) {
        const [tokenId, record, ...rest] = key.split(":");
        const rec = actorOf(result.state, tokenId!)?.turnRecord;
        if (rec?.id === Number(record) && rec.settled?.[rest.join(":") as PromptKey] === undefined) answers.delete(key);
      }
    }
    checkBounds(result.state, at);
    if (op.t === "encounter.next") {
      const back = applyOp(result.state, { t: "encounter.prev" }, DM, env(seq));
      assert.ok(back.ok, `${at}: Previous after Next`);
      assert.equal(turnState(back.state), turnState(state), `${at}: Next then Previous puts back every record, mark, damage type and pip`);
    }
    if (op.t === "actor.rest" && op.kind === "long") {
      const id = "tokenId" in op.target ? op.target.tokenId : undefined;
      const a = id ? actorOf(result.state, id) : result.state.characters.thorn!.actor;
      if (a) {
        assert.equal(a.uses, undefined, `${at}: a mark survived a Long Rest`);
        assert.equal(a.hurt, undefined, `${at}: damage types survived a Long Rest`);
        assert.equal(a.turnRecord?.took, undefined, `${at}: a record's took survived a Long Rest`);
      }
      const character = id === undefined || id === "thorn" ? result.state.characters.thorn : undefined;
      for (const res of character?.resources ?? []) assert.equal(res.used, 0, `${at}: ${res.name} survived a Long Rest`);
    }
    state = result.state;
  }
  // Replay from the first state as a reload hands it back, its maps in another order.
  let replayed = reordered(JSON.parse(JSON.stringify(first))) as RoomState;
  for (const { op, who, seq } of stored) {
    const again = applyOp(replayed, op, who, { ...env(seq), opVersion: 20 });
    assert.ok(again.ok, `seed ${seed}: replay refused ${op.t} at ${seq}: ${again.ok ? "" : again.message}`);
    replayed = again.state;
  }
  assert.equal(stableStringify(replayed), stableStringify(state), `seed ${seed}: replay rebuilds the same room`);
  return { applied, settled, refused };
}

describe("combat uses over random sequences (docs/design-v1-combat-controls.md 11)", () => {
  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}: 900 steps keep every invariant`, () => {
      const { applied, settled, refused } = run(seed, 900);
      assert.ok(applied > 400, `seed ${seed}: only ${applied} applied`);
      assert.ok(settled > 20, `seed ${seed}: only ${settled} prompts settled`);
      assert.ok(refused > 20, `seed ${seed}: only ${refused} refused, so the refusals go untested`);
    });
  }
});
