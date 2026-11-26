import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { RollRequest } from "#shared/model.ts";
import type { OpOf } from "#shared/protocol.ts";
import type { SaveOutcomeFields } from "#shared/saveOutcomeContract.ts";
import { targetKey } from "../../rolls/logic.ts";
import { apply, newPage, roll, rollAgain, type Command, type Page, type ServerRoll } from "./chain.ts";
import { askAgain, rerollSaves } from "./reroll.ts";
import type { RowBase } from "./rows.ts";

/**
 * Every list a group save sends names its creatures by id, whatever order
 * the page shows its rows in: by the DM's own names, which a name-hidden
 * creature's players never read, with ties in the order the rows' source
 * gave them, which for a trap's springing or a fall card is the server's.
 * So two pages whose rows differ only in order send the same commands.
 */

const page = (): Page => newPage({ id: "page", sceneId: "s1", source: { kind: "trap", trapId: "trap", due: "d", tokenIds: [] }, test: { kind: "save", ability: "dex" }, dc: 14, secret: false, spell: false, switches: { dcShown: false, resultShown: false }, fill: { name: "Pit", publicName: "Trap", from: "Trap" } });

/** A monster the server rolls for, under a name that sorts apart from its id. */
const monster = (id: string, name: string): RowBase => ({ holder: `token:${id}`, tokenId: id, target: { tokenId: id }, name, bonus: 1, ways: ["server"], skip: false });
/** A player's creature, asked. */
const played = (id: string, name: string): RowBase => ({ holder: `character:${id}`, tokenId: `tok-${id}`, target: { tokenId: `tok-${id}` }, askRef: { characterId: id }, name, bonus: 1, ways: ["ask"], skip: false });
const serverOf = (r: RowBase): ServerRoll => ({ holder: r.holder, target: r.target, bonus: 1, sources: [], extra: [] });

const monsters = [monster("m3", "Assassin"), monster("m1", "Unknown creature"), monster("m2", "Unknown creature"), monster("m0", "Zombie")];
const party = [played("c2", "Bryn"), played("c0", "Ash"), played("c1", "Cato")];

const creaturesIn = (send: readonly Command[]) => send.map((c) => (c.kind === "dice" ? c.rolls.map((r) => targetKey(r.creature as { tokenId?: string; characterId?: string })) : c.kind === "op" && c.op.t === "roll.ask" ? c.op.request.targets.map(targetKey) : []));
const ordered = (keys: readonly string[]) => [...keys].sort();

function rolled(rows: readonly RowBase[]) {
  let n = 0;
  return roll(page(), { rows: [...rows], server: rows.filter((r) => r.ways.includes("server")).map(serverOf), tag: "dice", requestIds: () => `ask-${n++}`, openRequests: 0, taken: [], at: "2026-11-25T00:00:00.000Z" });
}

test("a roll's dice line and requests list creatures by id whatever the rows' order", () => {
  const rows = [...monsters, ...party];
  const [a, b] = [rolled(rows), rolled([...rows].reverse())];
  assert.deepEqual(a.send, b.send);
  const [dice, ask] = creaturesIn(a.send);
  assert.deepEqual(dice, ["t:m0", "t:m1", "t:m2", "t:m3"]);
  assert.deepEqual(ask, ["c:c0", "c:c1", "c:c2"]);
});

test("past one request's targets, which creatures share a request follows their ids", () => {
  const many = Array.from({ length: LIMITS.rollTargets + 7 }, (_, i) => played(`p${String(i).padStart(3, "0")}`, i % 2 === 0 ? "Wolf" : `Hound ${i}`));
  const [a, b] = [rolled(many), rolled([...many].reverse())];
  assert.deepEqual(a.send, b.send);
  const asks = creaturesIn(a.send);
  assert.equal(asks.length, 2);
  assert.deepEqual(asks.flat(), ordered(asks.flat()), "the first request takes the lowest ids");
});

test("Roll them again lists its creatures by id", () => {
  const again = (rows: readonly RowBase[]) => {
    const p = rolled(monsters).page;
    const states = { ...p.states };
    for (const r of monsters) states[r.holder] = { way: "server", status: "notRolled" };
    return rollAgain({ ...p, states }, { holders: rows.map((r) => r.holder), server: rows.map(serverOf), tag: "again" });
  };
  const [a, b] = [again(monsters), again([...monsters].reverse())];
  assert.deepEqual(a.send, b.send);
  assert.deepEqual(creaturesIn(a.send)[0], ["t:m0", "t:m1", "t:m2", "t:m3"]);
});

test("Apply sends the outcome's creatures and a fall card's by id", () => {
  const applied = (rows: readonly RowBase[]) => {
    const p = rolled(monsters).page;
    const plan: OpOf<"actor.outcome"> & SaveOutcomeFields = { t: "actor.outcome", plan: "plan", label: "Pit", fall: { fallId: "fall", tokenIds: rows.map((r) => r.tokenId) }, targets: rows.map((r) => ({ target: r.target, amount: 3 })) };
    return apply(p, plan);
  };
  const [a, b] = [applied(monsters), applied([...monsters].reverse())];
  assert.deepEqual(a.send, b.send);
  const outcome = a.send.find((c) => c.kind === "outcome");
  assert.ok(outcome?.kind === "outcome");
  assert.deepEqual(outcome.op.targets.map((t) => targetKey(t.target)), ["t:m0", "t:m1", "t:m2", "t:m3"]);
  assert.deepEqual(outcome.op.fall?.tokenIds, ["m0", "m1", "m2", "m3"]);
});

test("a reroll's dice line and Ask again's request list creatures by id", () => {
  const rerolled = (rows: readonly RowBase[]) => {
    const p: Page = { ...page(), phase: "rolled", rows: [...rows] };
    for (const r of rows) p.states[r.holder] = { way: "server", rolled: { formula: "1d20+1", faces: [9], total: 10 } };
    return rerollSaves(p, { holders: rows.map((r) => r.holder), server: rows.map(serverOf), tag: "again" });
  };
  const [a, b] = [rerolled(monsters), rerolled([...monsters].reverse())];
  assert.deepEqual(a.send, b.send);
  assert.deepEqual(creaturesIn(a.send)[0], ["t:m0", "t:m1", "t:m2", "t:m3"]);

  const asked = (rows: readonly RowBase[]) => {
    const p: Page = { ...page(), phase: "rolled", rows: [...rows], requests: [{ rollId: "old", holders: rows.map((r) => r.holder), state: "closed" }] };
    for (const r of rows) p.states[r.holder] = { way: "ask", asked: { rollId: "old", dc: 14 } };
    // The old request lists its creatures in another order again, as a stored one may.
    const old: RollRequest = { id: "old", rev: 1, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 14, dcShown: false, resultShown: false, at: "2026-11-25T00:00:00.000Z", targets: [{ characterId: "c1" }, { characterId: "c2" }, { characterId: "c0" }] };
    return askAgain(p, { holders: [party[0]!.holder], requests: { old }, requestIds: () => "fresh" });
  };
  const [x, y] = [asked(party), asked([...party].reverse())];
  assert.deepEqual(x.send, y.send);
  assert.deepEqual(creaturesIn(x.send)[0], ["c:c0", "c:c1", "c:c2"]);
});

test("Ask again past one request's targets splits its creatures by id", () => {
  const many = Array.from({ length: LIMITS.rollTargets + 7 }, (_, i) => played(`p${String(i).padStart(3, "0")}`, i % 2 === 0 ? "Wolf" : `Hound ${i}`));
  const asked = (rows: readonly RowBase[]) => {
    const p: Page = { ...page(), phase: "rolled", rows: [...rows] };
    for (const r of rows) p.states[r.holder] = { way: "ask" };
    let n = 0;
    return askAgain(p, { holders: rows.map((r) => r.holder), requests: {}, requestIds: () => `fresh-${n++}` });
  };
  const [a, b] = [asked(many), asked([...many].reverse())];
  assert.deepEqual(a.send, b.send);
  const asks = creaturesIn(a.send);
  assert.equal(asks.length, 2);
  assert.deepEqual(asks.flat(), ordered(asks.flat()));
});
