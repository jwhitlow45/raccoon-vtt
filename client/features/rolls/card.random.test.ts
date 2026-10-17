import assert from "node:assert/strict";
import { test } from "node:test";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import {
  answered,
  answerFlow,
  answerKey,
  answerOffers,
  draftKey,
  finalForPlayer,
  foldsAfterSend,
  forgetStaleDrafts,
  IDLE,
  landingOf,
  startingAnswer,
  targetKey,
  type AnswerDraft,
  type AnswerFlow,
  type AnswerOp,
} from "./logic.ts";

/**
 * Randomized: the card's answers (docs/design-v1-roll-request.md 11.1).
 * 2,000 sequences of 40 events over one creature's answer on the player's
 * card and the card's fold, against a fake server that holds the request:
 * typing, taps of Roll, Send, Fail, Ask and Withdraw, each op's answer
 * taken, refused or unknown in any order (an unknown one landed or not),
 * the player's other device answering or asking, the DM's mark, roll,
 * Allow, Keep, Reopen and Close, the socket dropping and coming back, a
 * remount, and Later or Done. The card is driven only through logic.ts:
 * answerOffers, answerFlow, landingOf, foldsAfterSend and the drafts.
 *
 * Invariants, after every event:
 * 1. At most one op is in flight for the creature.
 * 2. Nothing is sent once the request is gone.
 * 3. No op is sent but by a tap: an unknown one is never sent again by itself.
 * 4. Roll is never offered once the creature has an answer, nor while the Total field holds text.
 * 5. Send and Fail are never offered on a final answer.
 * 6. The busy state ends by its own op's answer and only by it.
 * 7. The card never folds while the creature waits, unless Later or Done was tapped.
 * 8. A draft never outlives a change to its answer.
 */

type InFlight = { tag: string; op: AnswerOp; total?: number };
type World = {
  request: RollRequest | null;
  target: RollTarget;
  flow: AnswerFlow;
  text: string;
  connected: boolean;
  folded: boolean;
  rolledHere: Set<string>;
  sent: InFlight[];
  drafts: Map<string, AnswerDraft>;
  /** Taps the flow took, which is every op the card may send. */
  taps: number;
  next: number;
};

const REQUEST = (dcHidden: boolean): RollRequest => ({
  id: "r1",
  rev: 0,
  test: { kind: "save", choices: [{ ability: "dex" }] },
  ...(dcHidden ? { dcHidden: true as const } : { dc: 13 }),
  dcShown: !dcHidden,
  resultShown: true,
  at: "x",
  targets: [{ characterId: "thorn" }],
});

const KEY = draftKey("r1", { characterId: "thorn" });
const TKEY = targetKey({ characterId: "thorn" });

function withTarget(w: World, target: RollTarget): void {
  w.target = target;
  if (w.request) w.request = { ...w.request, targets: [target] };
}

/** The server applies an answer, as the reducer would, for the creature alone. */
function serverAnswer(w: World, by: "mine" | "other", kind: "roll" | "send" | "fail" | "mark", tag: string, total = 14): void {
  const current = w.target;
  if (kind === "mark") {
    const { change: _ask, ...kept } = current;
    withTarget(w, { ...kept, result: "pass", tag });
    return;
  }
  const next: RollTarget = { characterId: "thorn", tag };
  if (answered(current)) next.previous = { total: current.total ?? 0 };
  if (kind === "roll") Object.assign(next, { total, result: total >= 13 ? "pass" : "fail", dice: { formula: "1d20+3", faces: [total - 3], total } });
  else if (kind === "send") Object.assign(next, { total, result: total >= 13 ? "pass" : "fail" });
  else Object.assign(next, { noRoll: true, result: "fail" });
  void by;
  withTarget(w, next);
}

function offersOf(w: World) {
  return answerOffers({ holds: w.request !== null, request: w.request ?? REQUEST(false), target: w.target, text: w.text, connected: w.connected, bonusReady: true });
}

test("2,000 sequences of 40 card events keep every invariant", () => {
  const reached: Record<string, number> = {};
  const hit = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const hidden = chance(r, 0.5);
    const w: World = {
      request: REQUEST(hidden),
      target: { characterId: "thorn" },
      flow: IDLE,
      text: "",
      connected: true,
      folded: false,
      rolledHere: new Set(),
      sent: [],
      drafts: new Map(),
      taps: 0,
      next: 1,
    };
    const trail: string[] = [];
    let sentEver = 0;
    let laterTapped = false;
    for (let n = 0; n < 40; n++) {
      const before = { flow: w.flow, folded: w.folded, key: answerKey(w.target), request: w.request };
      const offers = offersOf(w);
      const final = w.request ? finalForPlayer(w.request, w.target) : false;
      // Invariants 4 and 5, on what the card offers now.
      if (answered(w.target) || w.text.trim() !== "") assert.equal(offers.roll, false, `Roll offered, seed ${seed}: ${trail.join(", ")}`);
      if (final) assert.ok(!offers.send && !offers.fail, `Send or Fail on a final answer, seed ${seed}: ${trail.join(", ")}`);

      const event = int(r, 0, 14);
      let name = "";
      const tapOp = (op: AnswerOp, total?: number) => {
        const tag = `t${w.next++}`;
        const next = answerFlow(w.flow, { t: "tap", op, tag, offers });
        if (next === w.flow) return;
        w.flow = next;
        w.taps++;
        hit(`tap ${op}`);
        // The card sends only while the request holds the creature, which the offers already said.
        assert.ok(w.request !== null, "a tap was taken after the request went");
        w.sent.push({ tag, op, ...(total !== undefined ? { total } : {}) });
        sentEver++;
      };
      switch (event) {
        case 0:
          w.text = pick(r, ["", "9", "15"]);
          w.flow = answerFlow(w.flow, { t: "edit" });
          if (w.request) w.drafts.set(KEY, { text: w.text, choice: 0, base: answerKey(w.target) });
          name = `type "${w.text}"`;
          break;
        case 1:
          tapOp("roll");
          name = "tap Roll";
          break;
        case 2:
          if (w.text !== "") tapOp("send", Number(w.text));
          name = "tap Send";
          break;
        case 3:
          tapOp("fail");
          name = "tap Fail";
          break;
        case 4:
          tapOp("ask");
          name = "tap Ask";
          break;
        case 5:
          tapOp("withdraw");
          name = "tap Withdraw";
          break;
        case 6:
        case 7: {
          // The answer to the op in flight, in any of its three forms.
          const op = w.sent.shift();
          name = "an answer";
          if (!op) break;
          const answer = pick(r, ["taken", "refused", "unknown"] as const);
          const lands = answer === "taken" || (answer === "unknown" && chance(r, 0.5));
          if (lands && w.request) {
            if (op.op === "roll" && !answered(w.target)) {
              serverAnswer(w, "mine", "roll", op.tag, int(r, 4, 23));
              w.rolledHere.add(TKEY);
            } else if (op.op === "send" && !finalForPlayer(w.request, w.target)) serverAnswer(w, "mine", "send", op.tag, op.total);
            else if (op.op === "fail" && !finalForPlayer(w.request, w.target)) serverAnswer(w, "mine", "fail", op.tag);
            else if (op.op === "ask" && w.target.change === undefined) withTarget(w, { ...w.target, change: { id: op.tag, on: w.target.tag ?? "", reason: "fix-total" } });
            else if (op.op === "withdraw" && w.target.change) {
              const { change: _c, ...rest } = w.target;
              withTarget(w, rest);
            }
          }
          const landing = answer === "unknown" ? (w.request ? landingOf(w.target, op.tag) : "none") : undefined;
          const was = w.flow;
          w.flow = answerFlow(w.flow, { t: "answer", tag: op.tag, answer, ...(answer === "refused" ? { text: "No." } : {}), ...(landing ? { landing } : {}) });
          // Invariant 6: the op's own answer ends the busy state.
          assert.equal(w.flow.busy, null, `busy outlived its answer, seed ${seed}`);
          void was;
          hit(`answer ${answer}${landing ? ` ${landing}` : ""}`);
          // A typed answer that landed folds the card once all have answered.
          if ((op.op === "send" || op.op === "fail") && (answer === "taken" || landing === "mine") && w.request && foldsAfterSend(w.request, TKEY, w.rolledHere)) w.folded = true;
          name = `answer ${op.op} ${answer}${landing ? ` ${landing}` : ""}`;
          break;
        }
        case 8:
          // The player's other device, or the DM, answers or rolls.
          if (w.request) {
            const kind = pick(r, ["roll", "send", "fail", "mark"] as const);
            if (kind === "mark" ? answered(w.target) : !answered(w.target)) serverAnswer(w, "other", kind, `o${w.next++}`, int(r, 4, 23));
            if (kind === "roll" && w.target.dice) w.rolledHere.add(TKEY);
            hit("other answer");
          }
          name = "another answer";
          break;
        case 9:
          // The DM reopens, or allows a Fix my total, or keeps an ask.
          if (w.request && answered(w.target)) {
            withTarget(w, { characterId: "thorn", previous: { total: w.target.total ?? 0 }, ...(w.target.change?.reason === "fix-total" && chance(r, 0.5) ? { retype: true as const } : {}) });
            hit("reopen");
          } else if (w.request && w.target.change) {
            const { change: _c, ...rest } = w.target;
            withTarget(w, rest);
            hit("keep");
          }
          name = "the DM reopens or keeps";
          break;
        case 10:
          if (chance(r, 0.3)) {
            w.request = null;
            hit("close");
          }
          name = "the DM may close";
          break;
        case 11:
          w.connected = !w.connected;
          name = w.connected ? "the socket comes back" : "the socket drops";
          break;
        case 12: {
          // Turning the phone mounts the card afresh, from its draft.
          if (w.request) forgetStaleDrafts(w.drafts, [w.request]);
          const start = startingAnswer(w.target, w.drafts.get(KEY));
          w.text = start.text;
          name = "remount";
          hit("remount");
          break;
        }
        case 13:
          w.folded = true;
          laterTapped = true;
          name = "Later or Done";
          break;
        default:
          name = "nothing";
      }
      trail.push(name);
      const where = `seed ${seed}: ${trail.join(", ")}`;
      // Invariant 1.
      assert.ok(w.sent.length <= 1, `two ops in flight, ${where}`);
      // Invariants 2 and 3: every op sent came from a tap the flow took, while the request held the creature.
      assert.equal(sentEver, w.taps, `an op went without a tap, ${where}`);
      if (before.request === null) assert.equal(w.sent.length === 0 || w.taps === sentEver, true, where);
      // Invariant 6: only an answer ends busy.
      if (before.flow.busy !== null && w.flow.busy === null) assert.match(name, /^answer /, `busy ended without its answer, ${where}`);
      // Invariant 7.
      if (w.folded && !before.folded && !laterTapped) assert.ok(w.request === null || answered(w.target), `folded while waiting, ${where}`);
      // Invariant 8: a draft typed over an answer that has changed since is forgotten.
      if (w.request) {
        forgetStaleDrafts(w.drafts, [w.request]);
        const draft = w.drafts.get(KEY);
        if (draft) assert.equal(draft.base, answerKey(w.target), `a stale draft, ${where}`);
      }
      // A request that went sends nothing more: drop what is in flight, which the receipt settles (doc 1 1.2).
      if (w.request === null && w.sent.length > 0) {
        const op = w.sent.shift()!;
        w.flow = answerFlow(w.flow, { t: "answer", tag: op.tag, answer: "refused", text: "gone" });
      }
    }
  }
  for (const path of ["tap roll", "tap send", "tap fail", "tap ask", "tap withdraw", "answer taken", "answer refused", "answer unknown mine", "answer unknown none", "answer unknown other", "other answer", "reopen", "keep", "close", "remount"]) {
    assert.ok((reached[path] ?? 0) > 0, `reached ${path}: ${JSON.stringify(reached)}`);
  }
});
