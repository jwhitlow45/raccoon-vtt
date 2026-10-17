import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { DiceRoll, LogEntry, RollRequest, RollTarget, RoomState } from "#shared/model.ts";
import type { OpOf } from "#shared/protocol.ts";
import { resultOf } from "#shared/rules/rolls.ts";
import { actor, character, chance, customMonster, effect, int, pick, rng, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { creatureKey } from "../options.ts";
import {
  apply,
  applyAgain,
  applySettled,
  askAnswered,
  damageSent,
  damageSettled,
  discard,
  dmRoll,
  dmRollSettled,
  mark,
  markGone,
  mayApplyAgain,
  newPage,
  results,
  roll,
  rollAgain,
  rollSettled,
  setDc,
  stateOf,
  syncRequests,
  typeTotal,
  type Command,
  type Page,
  type ServerRoll,
} from "./chain.ts";
import { buildPlan } from "./plan.ts";
import { groupRows, type Mark, type RowBase } from "./rows.ts";

/** An hour after the time every id of this test carries, so Apply again is still offered. */
const NOW = parseInt("0192f0a86c1e", 16) + 60 * 60 * 1000;

/**
 * The group save's page over many random orders of events
 * (docs/design-v1-roll-options.md 11, "Randomized"): batches landing,
 * refused or unknown, answers, reopens, live-card marks, the DM's waiting
 * Roll landing or refused, requests closed elsewhere, creatures deleted,
 * the DC changed, marks and amounts, Apply, its answer taken, refused or
 * unknown, Apply again, a request refused at the cap after the check while
 * another went, discard, and a reload. The invariants, after every step:
 *
 * 1. The outcome commits at most once.
 * 2. After discard nothing is sent but one `roll.close` per open request.
 * 3. No creature is rolled twice by the server, except a refused row, or an
 *    unknown one the DM rolls again by hand.
 * 4. Nothing rolls or applies again on its own while a receipt is pending
 *    or unknown: only the DM's own steps send.
 * 5. A row's result always follows 5.3's order over the newest events.
 * 6. A resent plan is the frozen plan, never a rebuilt one.
 * 7. Apply's plan names each holder once, only creatures still present,
 *    never a skipped row.
 * 8. A reload shows the same rows and results.
 * 9. A request refused at the cap leaves exactly its rows unasked, and every
 *    request and roll that went stands.
 */

const SEEDS = 2_000;
const STEPS = 40;

/** Four room monsters the server rolls, one Stunned, a hand-made token to type, a cart, and 52 party characters' tokens, so two requests go. */
function world(): RoomState {
  const tokens: RoomState["tokens"] = {};
  const characters: RoomState["characters"] = {};
  for (let i = 1; i <= 4; i++) {
    tokens[`m${i}`] = token(`m${i}`, { kind: "monster", name: "Lurker", number: i, actor: { inline: actor({ monsterId: "lurker", hp: { cur: 20, max: 20, temp: 0 }, ...(i === 4 ? { effects: [effect("st", { key: "stunned" })] } : {}) }) } });
  }
  tokens.hand = token("hand", { kind: "monster", name: "Bandit", actor: { inline: actor() } });
  tokens.cart = token("cart", { kind: "object", name: "Cart" });
  for (let i = 1; i <= 52; i++) {
    characters[`c${i}`] = character(`c${i}`, { name: `Hero ${i}`, ownerIds: ["p1"] });
    tokens[`p${i}`] = token(`p${i}`, { kind: "pc", name: `Hero ${i}`, ownerIds: ["p1"], actor: { ref: `c${i}` } });
  }
  return room({ monsters: { lurker: customMonster("lurker") }, tokens, characters });
}

const BASE = world();
const DICE: DiceView = { you: { memberId: "dm1", role: "dm" }, view: BASE, srd: { monsters: [], rolls: {} } };
const IDS = Object.keys(BASE.tokens);
const SAVE = { kind: "save" as const, ability: "dex" as const };
const ROWS: RowBase[] = groupRows(DICE, IDS, SAVE, false);
const key = (t: { tokenId?: string; characterId?: string }) => creatureKey(BASE, t);

function serverRolls(rows: readonly RowBase[]): ServerRoll[] {
  return rows.filter((r) => r.bonus !== null).map((r) => ({ holder: r.holder, target: r.target, bonus: r.bonus!, sources: [], extra: [] }));
}

type Oracle = Record<string, { mark?: Mark; answer?: RollTarget; asked?: boolean; rolled?: DiceRoll; typed?: number }>;

function expected(page: Page, row: RowBase, o: Oracle): Mark | null {
  const s = o[row.holder] ?? {};
  if (s.mark) return s.mark;
  if (s.answer) return resultOf(s.answer, page.dc ?? undefined) ?? null;
  if (s.asked) return null;
  const way = stateOf(page, row).way;
  if (way === "fails" && row.fails) return "fail";
  if (s.rolled?.fails) return "fail";
  const total = s.rolled?.total ?? s.typed;
  if (total === undefined || page.dc === null) return null;
  return total >= page.dc ? "pass" : "fail";
}

test("the group save's page keeps its invariants over 2,000 random sequences", () => {
  const reached: Record<string, number> = {};
  const count = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  let n = 0;
  const newId = () => `0192f0a8-6c1e-7a4b-9c3d-${String(++n).padStart(12, "0")}`;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let view: RoomState = BASE;
    let page: Page = newPage({ id: "page", sceneId: "s1", source: { kind: "selection", tokenIds: IDS }, test: SAVE, dc: int(r, 8, 16), secret: true, spell: false, switches: { dcShown: false, resultShown: true } });
    // Objects and the dead start marked Skip (5.2).
    const oracle: Oracle = Object.fromEntries(ROWS.filter((w) => w.skip).map((w) => [w.holder, { mark: "skip" as Mark }]));
    const rolledBy = new Map<string, number>();
    const allowedAgain = new Map<string, number>();
    const committedPlans = new Set<string>();
    const mayHave = new Set<string>();
    let applies = 0;
    let frozen: OpOf<"actor.outcome"> | null = null;
    let discarded = false;
    const servedRolls = new Map<string, { holders: string[] }>();
    for (let step = 0; step < STEPS && !discarded; step++) {
      const at = `seed ${seed} step ${step}`;
      const kind = pick(r, ["roll", "settle", "settle", "ask", "sync", "sync", "close", "dmRoll", "dmSettle", "mark", "type", "dc", "again", "damage", "apply", "applySettle", "applyAgain", "gone", "reload", "discard"] as const);
      const before = page;
      let send: Command[] = [];
      switch (kind) {
        case "roll": {
          const open = chance(r, 0.2) ? LIMITS.openRollsPerRoom - 1 : int(r, 0, 5);
          const out = roll(page, { rows: ROWS, server: serverRolls(ROWS), tag: newId(), requestIds: newId, openRequests: open, taken: [], at: "2026-10-17T20:00:00.000Z" });
          if (out.error) {
            assert.equal(out.page, page, `${at}: a refused roll changed the page`);
            assert.deepEqual(out.send, [], `${at}: a refused roll sent something`);
            count("rollRefused");
          }
          page = out.page;
          send = out.send;
          for (const c of send) {
            if (c.kind === "dice") servedRolls.set(c.tag, { holders: page.rolls.find((x) => x.tag === c.tag)!.holders });
          }
          for (const row of page.rows) if (page.states[row.holder]?.asked) (oracle[row.holder] ??= {}).asked = true;
          break;
        }
        case "settle": {
          const sent = page.rolls.filter((x) => x.state === "sending");
          const x = sent.length > 0 ? pick(r, sent) : undefined;
          if (!x) break;
          const outcome = pick(r, ["all", "some", "refused", "unknown"] as const);
          const lines: LogEntry[] = [];
          const rolledNow: string[] = [];
          for (const holder of x.holders) {
            if (outcome === "refused" || outcome === "unknown" || (outcome === "some" && chance(r, 0.4))) continue;
            const row = ROWS.find((w) => w.holder === holder)!;
            const roll: DiceRoll = { formula: "1d20+2", faces: [int(r, 1, 20)], total: 0, ...("tokenId" in row.target ? { tokenId: row.target.tokenId } : {}) };
            roll.total = roll.faces[0]! + 2;
            lines.push({ id: `${step}:${lines.length}`, at: "", kind: "event", data: { type: "dice", by: "dm1", to: "dm", rolls: [roll], tag: x.tag } });
            rolledNow.push(holder);
            (oracle[holder] ??= {}).rolled = roll;
          }
          const settled = outcome === "refused" ? { state: "refused" as const, says: "you are going too fast" } : outcome === "unknown" ? { state: "unknown" as const } : { state: "committed" as const, lines, ...(outcome === "some" ? { refused: "you are going too fast" } : {}) };
          page = rollSettled(page, x.tag, settled, key);
          count(`settle:${outcome}`);
          break;
        }
        case "ask": {
          const sending = page.requests.filter((x) => x.state === "sending");
          const x = sending.length > 0 ? pick(r, sending) : undefined;
          if (!x) break;
          const ok = chance(r, 0.75);
          page = askAnswered(page, x.rollId, ok ? { ok: true } : { ok: false, message: "20 requests are open" });
          if (ok) {
            const request: RollRequest = { id: x.rollId, rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: page.dc ?? 12, dcShown: false, resultShown: true, at: "", targets: x.holders.map((h) => ({ characterId: (ROWS.find((w) => w.holder === h)!.askRef as { characterId: string }).characterId }) as RollTarget) };
            view = { ...view, rolls: { ...view.rolls, [x.rollId]: request } };
            count("askTaken");
          } else {
            // 9: exactly its rows unasked, everything else as it stood.
            for (const h of x.holders) {
              assert.equal(page.states[h]?.status, "notAsked", `${at}: 9, ${h} not marked unasked`);
              assert.equal(page.states[h]?.asked, undefined);
              delete (oracle[h] ??= {}).asked;
            }
            for (const other of before.requests) if (other.rollId !== x.rollId) assert.deepEqual(page.requests.find((q) => q.rollId === other.rollId), other, `${at}: 9, another request changed`);
            assert.deepEqual(page.rolls, before.rolls, `${at}: 9, a roll changed`);
            count("askRefused");
          }
          break;
        }
        case "sync": {
          // Answers, live-card marks and reopens land in the view's requests.
          const ids = Object.keys(view.rolls);
          const id = ids.length > 0 ? pick(r, ids) : undefined;
          if (!id) break;
          const request = view.rolls[id]!;
          const i = int(r, 0, request.targets.length - 1);
          const t = request.targets[i]!;
          const change = pick(r, ["typed", "rolled", "mark", "reopen"] as const);
          const next: RollTarget =
            change === "typed"
              ? { characterId: t.characterId!, tag: `a${step}`, total: int(r, 1, 25) }
              : change === "rolled"
                ? { characterId: t.characterId!, tag: `a${step}`, total: 14, dice: { formula: "1d20", faces: [14], total: 14, ...(chance(r, 0.2) ? { fails: "stunned" as const } : {}) } }
                : change === "mark"
                  ? { ...t, mark: pick(r, ["pass", "fail"] as const) }
                  : { characterId: t.characterId! };
          view = { ...view, rolls: { ...view.rolls, [id]: { ...request, targets: request.targets.map((x, j) => (j === i ? next : x)) } } };
          page = syncRequests(page, view.rolls, key);
          // The newest answer the page copied is the oracle's: a reopen leaves the last one copied.
          for (const req of page.requests) {
            for (const h of req.holders) {
              const copied = page.states[h]?.answer;
              if (copied) (oracle[h] ??= {}).answer = copied;
            }
          }
          count(`sync:${change}`);
          break;
        }
        case "close": {
          // A request closed elsewhere: the page keeps what it copied.
          const ids = Object.keys(view.rolls);
          const id = ids.length > 0 ? pick(r, ids) : undefined;
          if (!id) break;
          const { [id]: _gone, ...rest } = view.rolls;
          view = { ...view, rolls: rest };
          page = syncRequests(page, view.rolls, key);
          count("closedElsewhere");
          break;
        }
        case "dmRoll": {
          const waiting = page.rows.filter((w) => page.states[w.holder]?.asked && !page.states[w.holder]?.answer);
          const row = waiting.length > 0 ? pick(r, waiting) : undefined;
          if (!row) break;
          const s = page.states[row.holder]!;
          const out = dmRoll(page, row.holder, { t: "roll.dice", tag: newId(), rollId: s.asked!.rollId, target: row.askRef!, unanswered: true });
          page = out.page;
          send = out.send;
          break;
        }
        case "dmSettle": {
          const sending = page.dmRolls.filter((x) => x.state === "sending");
          const x = sending.length > 0 ? pick(r, sending) : undefined;
          if (!x) break;
          page = dmRollSettled(page, x.tag, pick(r, ["committed", "refused", "unknown"] as const), "Answered before your roll.");
          count("dmSettle");
          break;
        }
        case "mark": {
          const row = pick(r, ROWS);
          const m = pick(r, ["fail", "pass", "skip", null] as const);
          const next = mark(page, row.holder, m);
          if (next !== page) {
            if (m) (oracle[row.holder] ??= {}).mark = m;
            else delete (oracle[row.holder] ??= {}).mark;
          }
          page = next;
          break;
        }
        case "type": {
          const row = pick(r, ROWS);
          const total = chance(r, 0.8) ? int(r, 1, 25) : null;
          const next = typeTotal(page, row.holder, total);
          if (next !== page) {
            if (total === null) delete (oracle[row.holder] ??= {}).typed;
            else (oracle[row.holder] ??= {}).typed = total;
          }
          page = next;
          break;
        }
        case "dc":
          page = setDc(page, chance(r, 0.15) ? null : int(r, 5, 20));
          break;
        case "again": {
          const stuck = page.rows.filter((w) => page.states[w.holder]?.status === "notRolled" || page.states[w.holder]?.status === "unknown").map((w) => w.holder);
          if (stuck.length === 0) break;
          const holders = stuck.filter(() => chance(r, 0.6));
          for (const h of holders) allowedAgain.set(h, (allowedAgain.get(h) ?? 0) + 1);
          const out = rollAgain(page, { holders, server: serverRolls(ROWS), tag: newId() });
          page = out.page;
          send = out.send;
          for (const c of send) if (c.kind === "dice") servedRolls.set(c.tag, { holders: page.rolls.find((x) => x.tag === c.tag)!.holders });
          count("again");
          break;
        }
        case "damage": {
          if (page.damage?.state === "sending") {
            page = damageSettled(page, page.damage.tag, pick(r, [{ state: "committed" as const, amounts: [int(r, 3, 30)] }, { state: "unknown" as const }]));
          } else {
            page = damageSent({ ...page, outcome: { ...page.outcome, damage: "3d6 fire" } }, newId());
          }
          break;
        }
        case "apply": {
          const plan = buildPlan(page, { ...DICE, view }, [{ amount: 9, type: "fire" }], { plan: newId(), newId });
          if (!plan) break;
          // 7.
          const holders = plan.targets.map((t) => key(t.target));
          assert.equal(new Set(holders).size, holders.length, `${at}: 7, a holder twice`);
          for (const t of plan.targets) {
            const row = page.rows.find((w) => key(w.target) === key(t.target))!;
            assert.ok(row, `${at}: 7, a creature with no row`);
            assert.notEqual(stateOf(page, row).mark, "skip", `${at}: 7, a skipped row`);
            assert.ok(!stateOf(page, row).gone, `${at}: 7, a creature that is gone`);
          }
          const out = apply(page, plan);
          if (out.send.length > 0) frozen = out.page.plan;
          page = out.page;
          send = out.send;
          count("apply");
          break;
        }
        case "applySettle": {
          if (page.phase !== "applying" || !page.plan) break;
          const outcome = pick(r, ["committed", "refused", "unknown"] as const);
          if (outcome === "committed") committedPlans.add(page.plan.plan);
          // A receipt that reads refused says the plan never applied, so a new one may go.
          if (outcome === "refused") mayHave.delete(page.plan.plan);
          page = applySettled(page, outcome === "refused" ? { state: "refused", says: "Too much for one step." } : { state: outcome });
          count(`apply:${outcome}`);
          break;
        }
        case "applyAgain": {
          const out = applyAgain(page, NOW);
          if (out.send.length > 0) {
            // 6.
            const resent = out.send.find((c) => c.kind === "outcome");
            assert.deepEqual(resent && resent.kind === "outcome" ? resent.op : null, frozen, `${at}: 6, a rebuilt plan was resent`);
            count("applyAgain");
          }
          page = out.page;
          send = out.send;
          break;
        }
        case "gone": {
          if (page.phase === "setup") break;
          const row = pick(r, ROWS);
          const { [row.tokenId]: _gone, ...tokens } = view.tokens;
          view = { ...view, tokens };
          page = markGone(page, (w) => view.tokens[w.tokenId] !== undefined);
          count("gone");
          break;
        }
        case "reload": {
          // 8.
          const restored = JSON.parse(JSON.stringify(page)) as Page;
          assert.deepEqual([...results(restored)], [...results(page)], `${at}: 8, a reload changed the results`);
          page = restored;
          count("reload");
          break;
        }
        case "discard": {
          const cmds = discard(page);
          // 2.
          const open = page.requests.filter((x) => x.state === "open" || x.state === "sending").map((x) => x.rollId);
          if (page.phase !== "applying") {
            assert.ok(cmds.every((c) => c.kind === "op" && c.op.t === "roll.close"), `${at}: 2, discard sent something else`);
            const closed = cmds.flatMap((c) => (c.kind === "op" && c.op.t === "roll.close" ? c.op.rollIds : []));
            assert.deepEqual([...closed].sort(), [...open].sort(), `${at}: 2, discard closed the wrong requests`);
            discarded = true;
            count("discard");
          }
          break;
        }
      }

      // 4: settling, syncing and the rest never send.
      if (!["roll", "dmRoll", "again", "apply", "applyAgain"].includes(kind)) assert.deepEqual(send, [], `${at}: 4, ${kind} sent on its own`);
      // 3.
      for (const c of send) {
        if (c.kind !== "dice") continue;
        for (const h of servedRolls.get(c.tag)?.holders ?? []) {
          const times = (rolledBy.get(h) ?? 0) + 1;
          rolledBy.set(h, times);
          assert.ok(times <= 1 + (allowedAgain.get(h) ?? 0), `${at}: 3, ${h} rolled ${times} times`);
        }
      }
      // 1: once a plan may have committed (taken or unknown), no other plan is ever sent.
      for (const c of send) {
        if (c.kind !== "outcome") continue;
        for (const p of mayHave) assert.equal(c.op.plan, p, `${at}: 1, a second plan was sent after ${p}`);
        applies++;
      }
      if (page.plan && (page.apply === "taken" || page.apply === "unknown")) mayHave.add(page.plan.plan);
      assert.ok(committedPlans.size <= 1, `${at}: 1, two plans committed`);
      // 5.
      if (page.phase !== "setup") {
        const got = results(page);
        for (const row of page.rows) {
          if (oracle[row.holder]?.rolled && page.states[row.holder]?.status) continue;
          assert.equal(got.get(row.holder), expected(page, row, oracle), `${at}: 5, ${row.holder} reads ${got.get(row.holder)}`);
        }
      }
    }
    void applies;
  }
  for (const k of ["rollRefused", "settle:all", "settle:some", "settle:refused", "settle:unknown", "askTaken", "askRefused", "sync:typed", "sync:rolled", "sync:mark", "sync:reopen", "closedElsewhere", "dmSettle", "again", "apply", "apply:committed", "apply:refused", "apply:unknown", "applyAgain", "gone", "reload", "discard"]) {
    assert.ok((reached[k] ?? 0) > 0, `never reached ${k}`);
  }
});

test("Apply again resends the frozen plan only while it is younger than a pending op may be, 12 hours", () => {
  const made = parseInt("0192f0a86c1e", 16);
  const plan: OpOf<"actor.outcome"> = { t: "actor.outcome", plan: "0192f0a8-6c1e-7a4b-9c3d-000000000001", targets: [{ target: { tokenId: "g1" }, amount: 9 }] };
  const page = { ...newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: ["g1"] }, test: { kind: "none" }, dc: null, secret: true, spell: false, switches: { dcShown: true, resultShown: true } }), phase: "applying", apply: "unknown", plan } as Page;
  assert.equal(mayApplyAgain(page, made + 11 * 60 * 60 * 1000), true);
  assert.deepEqual(applyAgain(page, made + 11 * 60 * 60 * 1000).send, [{ kind: "outcome", op: plan }]);
  assert.equal(mayApplyAgain(page, made + 12 * 60 * 60 * 1000), false);
  assert.deepEqual(applyAgain(page, made + 13 * 60 * 60 * 1000).send, []);
});
