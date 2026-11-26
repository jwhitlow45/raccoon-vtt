import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { RollRequest } from "#shared/model.ts";
import { projectArchivedLog } from "#shared/project.ts";
import type { OpOf } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { SaveOutcomeFields } from "#shared/saveOutcomeContract.ts";
import { AT, character, DM, env, P1, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { targetKey } from "../../rolls/logic.ts";
import { apply, newPage, roll, rollAgain, sourceIds, type Command, type Page, type ServerRoll, type Source } from "./chain.ts";
import { askAgain, rerollSaves } from "./reroll.ts";
import { groupRows, type RowBase } from "./rows.ts";

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

test("a creature two of whose tokens the room found rolls as the same token, whatever order the room keeps them in", () => {
  const view = room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    tokens: Object.fromEntries(["bree1", "bree2"].map((id) => [id, token(id, { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } })])),
  });
  const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view, srd: { monsters: [], rolls: {} } };
  const sources: Record<string, (found: string[]) => Source> = {
    area: () => ({ kind: "area", templateId: "a" }),
    trap: (found) => ({ kind: "trap", trapId: "trap", due: "d", tokenIds: found }),
    fall: (found) => ({ kind: "fall", fallId: "fall", tokenIds: found }),
  };
  /** P1's copy of the line the server writes for the page's roll, from the creatures the room found in this order. */
  const rolledFor = (kind: string, found: string[]) => {
    const rows = groupRows(dice, sourceIds(sources[kind]!(found), [], () => found), { kind: "save", ability: "dex" }, false, new Map());
    const p = page();
    for (const r of rows) p.states[r.holder] = { way: "server" };
    const step = roll(p, { rows, server: rows.map(serverOf), tag: "dice", requestIds: () => "ask", openRequests: 0, taken: [], at: AT });
    const sent = step.send.find((c) => c.kind === "dice");
    assert.ok(sent?.kind === "dice");
    const asked: OpOf<"dice.roll"> = { t: "dice.roll", tag: "dice", to: sent.to, rolls: sent.rolls.map(({ sources: _s, modeEligible: _m, ...r }) => r) };
    const out = applyOp(view, { t: "sys.dice", asked, batch: "AbCdEfGhIjKlMnOp", results: sent.rolls.map((r) => ({ formula: r.formula, faces: [10], total: 11 })) }, DM, env(1));
    assert.ok(out.ok, out.ok ? "" : out.message);
    return JSON.stringify(projectArchivedLog(out.state, out.state.log, P1, { sceneId: null }));
  };
  for (const kind of Object.keys(sources)) {
    const [a, b] = [rolledFor(kind, ["bree1", "bree2"]), rolledFor(kind, ["bree2", "bree1"])];
    assert.equal(a, b, kind);
    assert.ok(a.includes("bree1"), `${kind}: P1 reads the roll, named by one token`);
  }
});
