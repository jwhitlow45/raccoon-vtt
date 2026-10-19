import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { CastAsk, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { castAsk, castTable, chance, int, pick, rng } from "#shared/testutil.ts";
import type { ReceiptLookup } from "../../../lib/api.ts";
import type { OnAnswer } from "../../../state/types.ts";
import { ReceiptTracker } from "../useReceipt.ts";
import type { PanelRoll } from "../useDicePanel.ts";
import { askAgain, askFor, forgetSend, phaseOf, restoreSends, waitingLines, withdrawAsk, type CastEnv, type CastSend, type CastSends } from "./cast.ts";

/**
 * The player's send, randomized (docs/design-v1-player-save-spell.md 8, the
 * state machine rule): many sequences of taps with and without the roll,
 * answers that commit, refuse, come back unknown or come late, withdraws,
 * the DM's closes, Cancel, Ask again, reloads that lose every pending
 * answer and settle by receipt, and reconnects whose snapshot answers
 * unknown, against a fake server that keeps receipts by ask id.
 *
 * Invariants, after every step:
 * 1. One tap asks at most once, and rolls at most once.
 * 2. A refused ask never rolls again: Ask again sends no roll, and names the roll the first send named.
 * 3. Nothing is sent after Cancel or Withdraw, nor on any answer, close, reload or reconnect: only a tap or Ask again sends an ask.
 * 4. The waiting lines are exactly the asks in the view and the sends whose answer has not come.
 * 5. An unknown never sends again on its own (3 covers it: no event but a tap or Ask again sends).
 * And a tap without a connection sends nothing.
 */

type Sent = { op: ClientOp; onAnswer: OnAnswer; answered: boolean };
type Server = { receipts: Map<string, "committed" | "refused">; view: RoomState };

const fire: PanelRoll = { formula: "8d6", label: "Fireball damage, Fire", creature: { characterId: "thorn-c" } };

/** One page load: a reload makes a new one, with the server, the session draft and the id counter kept. */
function makePage(server: Server, draft: { sends: CastSend[] }, ids: { n: number }) {
  const sent: Sent[] = [];
  let connected = true;
  const tracker = new ReceiptTracker();
  tracker.env = {
    lookup: (tag): Promise<ReceiptLookup> => {
      const r = server.receipts.get(tag);
      if (r === "committed") return Promise.resolve({ parts: [{ part: 0, state: "committed", seq: 1, lines: [] }] });
      if (r === "refused") return Promise.resolve({ parts: [{ part: 0, state: "refused", code: "invalid", message: "Not this time." }] });
      return Promise.resolve({ parts: [] });
    },
    log: () => [],
  };
  const env: CastEnv = {
    store: createStore<CastSends>(() => ({ sends: {}, withdrawing: {} })),
    tracker,
    connected: () => connected,
    dispatch: (op, opts) => {
      if (!connected) return null;
      sent.push({ op, onAnswer: opts.onAnswer, answered: false });
      return sent.length;
    },
    rollDamage: (r) => {
      if (!connected) return null;
      const tag = `roll-${++ids.n}`;
      sent.push({ op: { t: "dice.roll", tag, to: "all", rolls: r.map((x) => ({ formula: x.formula })) }, onAnswer: () => undefined, answered: true });
      return { tag, parts: 1 };
    },
    newId: () => `ask-${++ids.n}`,
    view: () => server.view,
    save: (sends) => (draft.sends = [...sends]),
    notify: () => undefined,
  };
  return { env, sent, setConnected: (on: boolean) => (connected = on) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a player's send for saves, over random sequences", () => {
  test("keeps its invariants", async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const server: Server = { receipts: new Map(), view: castTable() };
      const draft = { sends: [] as CastSend[] };
      const ids = { n: 0 };
      let page = makePage(server, draft, ids);
      let blockOpen = true;
      const label = (step: number, what: string) => `seed ${seed} step ${step} ${what}`;

      for (let step = 0; step < 40; step++) {
        const before = page.sent.length;
        const sends = () => page.env.store.getState().sends;
        const pending = () => page.sent.filter((s) => !s.answered && s.op.t === "cast.ask");
        let what = "";
        let mayAsk = false;
        let mayRoll = false;
        let askedAgainFrom: CastSend | undefined;
        const n = int(r, 0, 12);
        if (n <= 2) {
          what = "tap";
          if (blockOpen) {
            mayAsk = true;
            mayRoll = true;
            askFor(page.env, { key: "c:thorn-c", spell: "Fireball", area: "a1", ask: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" }, rolls: chance(r, 0.6) ? [fire] : null });
          }
        } else if (n <= 4) {
          what = "answer";
          const list = pending();
          if (list.length > 0) {
            const s = pick(r, list);
            const id = (s.op as Extract<ClientOp, { t: "cast.ask" }>).cast.id;
            const kind = pick(r, ["taken", "taken", "refused", "unknown", "late"] as const);
            if (kind !== "late") {
              s.answered = true;
              if (kind === "taken") {
                server.receipts.set(id, "committed");
                server.view = { ...server.view, casts: { ...server.view.casts, [id]: castAsk(id) } };
                s.onAnswer("taken");
              } else if (kind === "refused") {
                server.receipts.set(id, "refused");
                s.onAnswer("refused", { code: "invalid", message: "Not this time.", text: "Not this time." });
              } else {
                // The answer was lost: the server may or may not have taken it.
                if (chance(r, 0.5)) {
                  server.receipts.set(id, "committed");
                  server.view = { ...server.view, casts: { ...server.view.casts, [id]: castAsk(id) } };
                }
                s.onAnswer("unknown", undefined, "expired");
              }
            }
          }
        } else if (n === 5) {
          what = "DM close";
          const ids = Object.keys(server.view.casts);
          if (ids.length > 0) {
            const { [pick(r, ids)]: _gone, ...rest } = server.view.casts;
            server.view = { ...server.view, casts: rest };
          }
        } else if (n === 6) {
          what = "withdraw";
          const ids = Object.keys(server.view.casts);
          if (ids.length > 0) {
            const id = pick(r, ids);
            withdrawAsk(page.env, id);
            const s = page.sent.at(-1);
            if (s && s.op.t === "cast.close" && chance(r, 0.7)) {
              s.answered = true;
              const { [id]: _gone, ...rest } = server.view.casts;
              server.view = { ...server.view, casts: rest };
              s.onAnswer("taken");
            }
          }
        } else if (n === 7) {
          what = "cancel";
          blockOpen = false;
        } else if (n === 8) {
          what = "reopen";
          blockOpen = true;
        } else if (n === 9) {
          what = "ask again";
          const settled = Object.values(sends()).filter((s) => {
            const phase = phaseOf(page.env.tracker.state(s.id), server.view.casts[s.id] !== undefined);
            return phase === "refused" || phase === "unknown";
          });
          if (settled.length > 0) {
            askedAgainFrom = pick(r, settled);
            mayAsk = true;
            if (chance(r, 0.8)) askAgain(page.env, askedAgainFrom.id);
            else forgetSend(page.env, askedAgainFrom.id);
          }
        } else if (n === 10) {
          what = "reload";
          page = makePage(server, draft, ids);
          restoreSends(page.env, draft.sends);
        } else if (n === 12) {
          // The socket drops, and a tap then sends nothing (3.1, doc 1's words on the button).
          what = "offline";
          page.setConnected(false);
          askFor(page.env, { key: "c:thorn-c", spell: "Fireball", area: "a1", ask: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" }, rolls: [fire] });
          page.setConnected(true);
        } else {
          what = "reconnect";
          for (const s of pending()) {
            const id = (s.op as Extract<ClientOp, { t: "cast.ask" }>).cast.id;
            s.answered = true;
            if (chance(r, 0.5)) {
              server.receipts.set(id, "committed");
              server.view = { ...server.view, casts: { ...server.view.casts, [id]: castAsk(id) } };
            }
            s.onAnswer("unknown", undefined, "snapshot");
          }
        }
        await settle();

        const fresh = page.sent.slice(Math.min(before, page.sent.length));
        const asks = fresh.filter((s) => s.op.t === "cast.ask");
        const rollsSent = fresh.filter((s) => s.op.t === "dice.roll");
        assert.ok(asks.length <= 1, label(step, `${what}: one tap asks at most once`));
        assert.ok(rollsSent.length <= 1, label(step, `${what}: one tap rolls at most once`));
        if (!mayAsk) assert.equal(asks.length, 0, label(step, `${what}: nothing asks on its own`));
        if (!mayRoll) assert.equal(rollsSent.length, 0, label(step, `${what}: nothing rolls on its own, Ask again included`));
        if (askedAgainFrom && asks[0]) {
          const cast = (asks[0].op as Extract<ClientOp, { t: "cast.ask" }>).cast;
          assert.deepEqual(cast.damage, askedAgainFrom.damage, label(step, "Ask again names the first roll"));
        }
        if (what === "withdraw") assert.ok(fresh.every((s) => s.op.t === "cast.close"), label(step, "a withdraw sends only its close"));

        // The waiting lines: the asks in the view, and the sends whose answer has not come, nothing else.
        const lines = waitingLines(server.view, sends(), (id) => page.env.tracker.state(id))
          .map((l) => l.id)
          .sort();
        const waiting = new Set<string>(Object.keys(server.view.casts));
        for (const s of Object.values(sends())) {
          const state = page.env.tracker.state(s.id);
          if (state === null || state.state === "sending" || state.state === "checking") waiting.add(s.id);
        }
        assert.deepEqual(lines, [...waiting].sort(), label(step, `${what}: waiting lines`));
        // An answered send never shows as waiting, and an unanswered one that is not in the view always does.
        for (const s of page.sent) {
          if (s.op.t !== "cast.ask") continue;
          const id = s.op.cast.id;
          if (!sends()[id]) continue;
          if (!s.answered && server.view.casts[id] === undefined) assert.ok(lines.includes(id), label(step, `${what}: an unanswered ask waits`));
        }
        const asksInView: CastAsk[] = Object.values(server.view.casts);
        for (const ask of asksInView) assert.ok(lines.includes(ask.id), label(step, `${what}: an ask in the view waits`));
      }
    }
  });
});
