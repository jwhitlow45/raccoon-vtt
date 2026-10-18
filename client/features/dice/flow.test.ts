import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { parseFormula } from "#shared/dice/formula.ts";
import { rollFormula } from "#shared/dice/roll.ts";
import { compareLogIds } from "#shared/keys.ts";
import type { LogEntry, Viewer } from "#shared/model.ts";
import type { ClientMessage, ClientOp, OpOf, ServerMessage } from "#shared/protocol.ts";
import { chance, int, pick, rng, room } from "#shared/testutil.ts";
import type { ReceiptLookup } from "../../lib/api.ts";
import { createRoomStore, OP_ANSWER_MS } from "../../state/store.ts";
import { FakeClock } from "../../state/testing.ts";
import type { RollSender } from "./send.ts";
import { againOf, createDicePanel, type DiceState } from "./useDicePanel.ts";
import { findRolls } from "./logic.ts";
import { ReceiptTracker } from "./useReceipt.ts";

/**
 * The Dice panel's flow, randomized (docs/design-v1-dice.md 8.4, 8.7 and
 * 1.2): many sequences of panel rolls, rolls with their own visibility,
 * take() at a tap, choice taps, batches, refusals, acks, dropped sockets,
 * resends, a log that trims old lines, lookups and snapshots, against a
 * fake server with a scripted draw and the server's receipt rules. The
 * real room store and the real receipt tracker run on top of it.
 */
const ME: Viewer = { memberId: "p1", role: "player" };
const KEEP = 6;

type Receipt = { state: "committed"; seq: number } | { state: "refused"; code: "invalid" | "forbidden"; message: string };

/** One room's server as the device meets it: the watermark, the receipts by tag and part, and a log it trims. */
class FakeServer {
  readonly r: () => number;
  seq = 0;
  watermark = 0;
  log: LogEntry[] = [];
  /** Every line ever written, which the receipt lookup reads as the room's stored log does. */
  archive: LogEntry[] = [];
  receipts = new Map<string, Receipt>();
  /** What each tag part drew, and with which op numbers it arrived. */
  draws = new Map<string, number>();
  numbers = new Map<string, Set<number>>();
  face = 0;

  constructor(r: () => number) {
    this.r = r;
  }

  /** One op, as the actor answers it. `null` for one it never got to, past a gap. */
  handle(n: number, op: ClientOp): Extract<ServerMessage, { t: "ev" }> | null {
    if (n <= this.watermark) return { t: "ev", seq: this.seq, changes: [], acks: [n] };
    if (n > this.watermark + 1) return null;
    this.watermark = n;
    if (op.t !== "dice.roll") return { t: "ev", seq: this.seq, changes: [], acks: [n] };
    const key = `${op.tag}|${op.part ?? 0}`;
    const numbers = this.numbers.get(key) ?? new Set<number>();
    numbers.add(n);
    this.numbers.set(key, numbers);
    const held = this.receipts.get(key);
    if (held) return held.state === "committed" ? { t: "ev", seq: this.seq, changes: [], acks: [n] } : { t: "ev", seq: this.seq, changes: [], rejects: [{ n, code: held.code, message: held.message }] };
    // An admission refusal leaves no receipt, so the same tag sent later may still roll.
    if (chance(this.r, 0.1)) return { t: "ev", seq: this.seq, changes: [], rejects: [{ n, code: "quota", message: "You are going too fast. Wait a few seconds." }] };
    if (chance(this.r, 0.12)) {
      this.receipts.set(key, { state: "refused", code: "forbidden", message: "You roll only for your own creatures." });
      return { t: "ev", seq: this.seq, changes: [], rejects: [{ n, code: "forbidden", message: "You roll only for your own creatures." }] };
    }
    this.draws.set(key, (this.draws.get(key) ?? 0) + 1);
    const results = op.rolls.map((roll) => {
      const parsed = parseFormula(roll.formula);
      assert.ok(parsed.ok, `the device sent a formula that parses: ${roll.formula}`);
      const rolled = rollFormula(parsed.formula, (sides) => 1 + (this.face++ % sides), roll.mode);
      assert.ok(rolled.ok, "every mode applies");
      return rolled.result;
    });
    this.seq++;
    const entry: LogEntry = { id: `${this.seq}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "dice", tag: op.tag, ...(op.part !== undefined ? { part: op.part } : {}), batch: "AbCdEfGhIjKlMnOp", by: ME.memberId, to: op.to, rolls: results } };
    this.log.push(entry);
    this.archive.push(entry);
    this.receipts.set(key, { state: "committed", seq: this.seq });
    const changes: Extract<ServerMessage, { t: "ev" }>["changes"] = [{ key: `log:${entry.id}`, value: entry }];
    // The live log keeps its newest lines only, as the room's 200 do.
    while (this.log.length > KEEP) changes.push({ key: `log:${this.log.shift()!.id}`, deleted: true });
    return { t: "ev", seq: this.seq, changes, acks: [n] };
  }

  snapshot(): Extract<ServerMessage, { t: "snapshot" }> {
    return { t: "snapshot", seq: this.seq, state: { ...room(), log: [...this.log] }, you: { memberId: ME.memberId, role: "player", sceneId: "s1" }, watermark: this.watermark };
  }

  /** The receipt lookup: every part of the tag the server holds a receipt for, with lines the live log may have trimmed. */
  lookup(tag: string): ReceiptLookup {
    const parts: ReceiptLookup["parts"] = [];
    for (const [key, receipt] of this.receipts) {
      const [t, part] = key.split("|");
      if (t !== tag) continue;
      if (receipt.state === "committed") parts.push({ part: Number(part), state: "committed", seq: receipt.seq, lines: this.archive.filter((e) => e.id === `${receipt.seq}:0`) });
      else parts.push({ part: Number(part), state: "refused", code: receipt.code, message: receipt.message });
    }
    return { parts };
  }
}

describe("the Dice panel's flow, randomized (docs/design-v1-dice.md 8.4 and 8.7)", () => {
  test("a tag rolls once, unknown never sends again, a taken choice goes with one roll, late answers leave newer choices, and every roll settles", async () => {
    /** What the runs reached, so the test fails if the sequences stop covering a path it names. */
    const seen = new Map<string, number>();
    const saw = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const server = new FakeServer(r);
      const clock = new FakeClock();
      const sent: ClientMessage[] = [];
      let socketOpen = true;
      const roomStore = createRoomStore({ roomId: "R1", you: ME, clock, random: () => 0.5, clientId: "c1" });
      roomStore.setOutbox({
        send(msg) {
          if (!socketOpen) return false;
          sent.push(msg);
          return true;
        },
      });
      const lookups: Promise<void>[] = [];
      const tracker = new ReceiptTracker();
      tracker.env = {
        lookup: (tag) => {
          saw("lookup");
          const answer = Promise.resolve(server.lookup(tag));
          lookups.push(answer.then(() => undefined));
          return answer;
        },
        log: () => roomStore.store.getState().view?.log ?? [],
      };
      const sender: RollSender = { dispatch: (op, opts) => roomStore.dispatch(op, opts), connected: () => roomStore.store.getState().connection === "open", receipts: tracker };
      const choices = createStore<DiceState>(() => ({ adv: false, dis: false, secret: null, version: 0, last: null }));
      const panel = createDicePanel({ store: choices, sender, secretStart: () => false });

      const connect = () => {
        roomStore.prepareHello();
        socketOpen = true;
        roomStore.applySnapshot(server.snapshot());
        roomStore.setConnection("open");
      };
      const drop = () => {
        socketOpen = false;
        sent.length = 0;
        roomStore.suspend();
        roomStore.setConnection("reconnecting");
      };
      /** The server takes what the device sent, and some of its answers come back, unless the socket drops on the way. */
      const deliver = (lose: boolean) => {
        const ops = sent.splice(0).flatMap((m) => (m.t === "op" ? [m] : []));
        const answers = ops.flatMap((m) => {
          const ev = server.handle(m.n, m.op as ClientOp);
          return ev ? [ev] : [];
        });
        if (lose) {
          saw("lost answers");
          drop();
          return;
        }
        for (const ev of answers) roomStore.applyEv(ev);
      };
      const settleLookups = async () => {
        while (lookups.length > 0) await Promise.all(lookups.splice(0));
      };

      /** The model of the choices: what the store must hold after every step. */
      let model = { adv: false, dis: false, secret: false };
      /** Tags this test asked to roll, and how many ops each went in. */
      const tags = new Map<string, { parts: number }>();
      /** Each panel roll that took Adv, by the press that turned it on. */
      let advPress = 0;
      const advTakenBy = new Map<number, number>();

      connect();
      for (let step = 0; step < 60; step++) {
        const what = r();
        if (what < 0.12) {
          const choice = pick(r, ["adv", "dis", "secret"] as const);
          panel.press(choice);
          if (choice === "secret") model = { ...model, secret: !model.secret };
          else if (choice === "adv") {
            model = { ...model, adv: !model.adv, dis: false };
            if (model.adv) advPress++;
          } else model = { ...model, dis: !model.dis, adv: false };
        } else if (what < 0.5) {
          // A panel roll from the field or an option: it takes the choices at the tap.
          const many = chance(r, 0.15);
          const rolls = Array.from({ length: many ? int(r, 21, 30) : int(r, 1, 3) }, () => ({ formula: pick(r, ["1d20+5", "2d6+3", "1d20", "4d6kh3"]), label: "x" }));
          const before = model;
          const tag = panel.roll(rolls);
          if (tag !== null) {
            const ops = Math.ceil(rolls.length / 20);
            tags.set(tag, { parts: ops });
            if (before.adv && rolls.some((x) => x.formula.startsWith("1d20"))) advTakenBy.set(advPress, (advTakenBy.get(advPress) ?? 0) + 1);
            model = { adv: false, dis: false, secret: false };
            const last = choices.getState().last;
            assert.ok(last && "tag" in last && last.tag === tag, `seed ${seed}: the sticky line is the newest panel roll`);
            const op = sent.at(-1);
            assert.ok(op?.t === "op" && (op.op as OpOf<"dice.roll">).to === (before.secret ? "dm" : "all"), `seed ${seed}: it went under the taken Secret`);
          } else {
            assert.ok(!socketOpen, `seed ${seed}: a roll is refused before sending only without a connection`);
          }
        } else if (what < 0.6) {
          // A card or the tracker: its own visibility, and the choices stay as they are.
          const lastBefore = choices.getState().last;
          const tag = panel.roll([{ formula: "1d20+2" }], { to: pick(r, ["all", "dm"] as const) });
          if (tag !== null) tags.set(tag, { parts: 1 });
          assert.equal(choices.getState().last, lastBefore, `seed ${seed}: a roll with its own visibility is not the panel's`);
        } else if (what < 0.82) {
          deliver(chance(r, 0.15));
        } else if (what < 0.88) {
          if (!socketOpen) connect();
          else drop();
        } else if (what < 0.94) {
          // Unanswered ops are resent with their numbers.
          clock.advance(OP_ANSWER_MS + 1);
        } else {
          await settleLookups();
        }
        const s = choices.getState();
        // A refused roll gives the choices back only while they still stood at their start, so the model follows the store there.
        if (s.adv !== model.adv || s.dis !== model.dis || (s.secret ?? false) !== model.secret) {
          assert.ok(s.version > 0, `seed ${seed}: the choices changed with no tap or give-back`);
          assert.ok(!model.adv && !model.dis && !model.secret, `seed ${seed}: a give-back came while a newer choice stood`);
          // The refused roll gave its Advantage back, so the next roll that takes it is the first to roll with it.
          if (s.adv) advTakenBy.set(advPress, (advTakenBy.get(advPress) ?? 1) - 1);
          model = { adv: s.adv, dis: s.dis, secret: s.secret ?? false };
        }
      }
      // Back online, everything answered, every lookup done.
      if (!socketOpen) connect();
      for (let i = 0; i < 6; i++) {
        deliver(false);
        clock.advance(OP_ANSWER_MS + 1);
      }
      deliver(false);
      await settleLookups();

      for (const [key, times] of server.draws) assert.equal(times, 1, `seed ${seed}: ${key} was drawn ${times} times`);
      for (const [key, numbers] of server.numbers) assert.equal(numbers.size, 1, `seed ${seed}: ${key} arrived under ${numbers.size} op numbers, so something sent it again on its own`);
      for (const [press, times] of advTakenBy) assert.ok(times <= 1, `seed ${seed}: the Advantage of press ${press} went with ${times} rolls`);
      for (const [tag] of tags) {
        const state = tracker.state(tag);
        assert.ok(state && state.state !== "sending" && state.state !== "checking", `seed ${seed}: ${tag} is still ${state?.state}`);
        saw(state.state);
        const held = [...server.receipts.entries()].filter(([k]) => k.startsWith(`${tag}|`)).map(([, v]) => v);
        if (state.state === "committed") {
          assert.ok(held.some((h) => h.state === "committed"), `seed ${seed}: committed on the server too`);
          // One line for each part the server committed, however much of them the live log trimmed: none lost, none twice, in log order.
          const ids = state.lines.map((l) => l.id);
          assert.equal(ids.length, held.filter((h) => h.state === "committed").length, `seed ${seed}: ${tag} shows ${ids.length} lines for its committed parts`);
          assert.equal(new Set(ids).size, ids.length, `seed ${seed}: ${tag} shows a line twice`);
          assert.deepEqual(ids, [...ids].sort(compareLogIds), `seed ${seed}: ${tag}'s lines are out of order`);
          // A part the server refused never reads as committed because another part of its tag committed.
          if (held.some((h) => h.state === "refused")) assert.ok(state.refused, `seed ${seed}: ${tag} hides the refusal of one of its parts`);
          const live = findRolls(roomStore.store.getState().view?.log ?? [], tag).length;
          if (live > 0 && live < ids.length) saw("partly trimmed");
          if (ids.length > 1) saw("committed group");
        }
        if (state.state === "refused") assert.ok(held.every((h) => h.state === "refused"), `seed ${seed}: refused on the server too, or at admission`);
      }
      assert.equal(roomStore.store.getState().pending.length, 0, `seed ${seed}: nothing is left pending`);
      roomStore.dispose();
    }
    for (const what of ["committed", "refused", "unknown", "lookup", "committed group", "partly trimmed"]) assert.ok((seen.get(what) ?? 0) > 0, `the runs never reached: ${what}`);
  });
});

describe("a roll that cannot go (docs/design-v1-dice.md 4.5 and 11)", () => {
  function panelWith(sender: Partial<RollSender>) {
    const tracker = new ReceiptTracker();
    const choices = createStore<DiceState>(() => ({ adv: true, dis: false, secret: null, version: 3, last: null }));
    const full: RollSender = { dispatch: () => 1, connected: () => true, receipts: tracker, ...sender };
    // A DM's panel: a roll for a creature, here a monster, starts secret, and a free formula in the open (docs/design-v1-dice.md 17).
    return { choices, panel: createDicePanel({ store: choices, sender: full, secretStart: (creatures) => creatures.length > 0 }) };
  }

  test("offline, nothing is sent, the sticky line says why, and the taken choices come back", () => {
    const { choices, panel } = panelWith({ connected: () => false });
    assert.equal(panel.roll([{ formula: "1d20+3" }]), null);
    const s = choices.getState();
    assert.equal(s.adv, true);
    assert.deepEqual(s.last && "error" in s.last ? s.last.error : null, "Rolling needs a connection.");
  });

  test("a preview as a player, which refuses every op, sends nothing either", () => {
    const { choices, panel } = panelWith({ dispatch: () => null });
    assert.equal(panel.roll([{ formula: "1d20+3" }]), null);
    assert.equal(choices.getState().adv, true);
  });

  test("a typed mode on a roll with no d20 is refused before sending, and the panel's choices never reach one", () => {
    const sent: ClientOp[] = [];
    const { choices, panel } = panelWith({
      dispatch: (op) => {
        sent.push(op);
        return sent.length;
      },
    });
    assert.equal(panel.roll([{ formula: "2d6", sources: [{ kind: "adv", from: "typed" }] }]), null);
    const s = choices.getState();
    assert.deepEqual(s.last && "error" in s.last ? s.last.error : null, "Advantage and Disadvantage need one d20 in the roll.");
    assert.notEqual(panel.roll([{ formula: "2d6" }]), null);
    assert.equal((sent[0] as OpOf<"dice.roll">).rolls[0]?.mode, undefined, "Adv pressed never goes on damage");
    assert.equal((sent[0] as OpOf<"dice.roll">).to, "all", "a DM's free formula starts in the open");
    assert.notEqual(panel.roll([{ formula: "1d20+4", creature: { tokenId: "goblin" } }]), null);
    assert.equal((sent[1] as OpOf<"dice.roll">).to, "dm", "a DM's roll for a monster starts secret");
  });
});

describe("an answer or a death save in the header line (LP7-DICE-10, docs/design-v1-dice-ui.md 4.1)", () => {
  function panel() {
    const choices = createStore<DiceState>(() => ({ adv: false, dis: false, secret: null, version: 0, last: null }));
    const sender: RollSender = { dispatch: () => 1, connected: () => true, receipts: new ReceiptTracker() };
    return { choices, panel: createDicePanel({ store: choices, sender, secretStart: () => false }) };
  }

  test("noted sets the line with no Again, a later roll replaces it, and Again is never offered for it", () => {
    const { choices, panel: p } = panel();
    p.noted("tag-answer", "Dexterity save");
    assert.deepEqual(choices.getState().last, { tag: "tag-answer", once: true, label: "Dexterity save" });
    assert.equal(againOf(choices.getState().last), null, "an answer cannot go again as it went");
    const tag = p.roll([{ formula: "1d20+3", label: "Longsword" }]);
    assert.notEqual(tag, null);
    const last = choices.getState().last;
    assert.ok(last && "rolls" in last && last.tag === tag, "the free roll is the newest line");
    assert.equal(againOf(last)?.rolls[0]?.formula, "1d20+3");
    p.noted("tag-death", "Death Save");
    assert.equal(againOf(choices.getState().last), null, "a death save after it takes the line, with no Again");
  });

  test("a refusal before sending has no Again either", () => {
    assert.equal(againOf({ error: "Rolling needs a connection.", at: 0 }), null);
    assert.equal(againOf(null), null);
  });
});
