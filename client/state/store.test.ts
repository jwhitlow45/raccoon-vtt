import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "#shared/model.ts";
import { BLOCK_SAVES_TOO_FAST, checkLimits, LIMITS } from "#shared/limits.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp, ServerMessage } from "#shared/protocol.ts";
import { actor, character, companionBlock, DM, entry, P1, P2, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { turnOp } from "../features/encounter/logic.ts";
import { DRAG_END_HOLD_MS, PREVIEW_IDLE_MS } from "./ephemeral.ts";
import { createRoomStore, MAX_OP_AGE_MS, OP_ANSWER_MS, refusalText, type RoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";
import { INITIAL_LOCAL, panelView, sheetOpen, withoutBelow, withPanel, type LocalUi, type OpAnswer, type OpRefusal, type UnknownCause } from "./types.ts";

type Snapshot = Extract<ServerMessage, { t: "snapshot" }>;
type Ev = Extract<ServerMessage, { t: "ev" }>;

function setup(state: RoomState, viewer: Viewer = DM, sceneId = "s1") {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), viewer, sceneId);
  // random() = 0.5 puts the jitter at exactly zero, so backoff delays are exact.
  const room = createRoomStore({ roomId: "R1", you: viewer, clock, random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  const connect = () => {
    const hello = room.prepareHello();
    room.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId }));
  };
  /** Delivers the ops the store sent since the last call to the server as one batch, and its answers back to the store. */
  const deliver = (): ServerMessage[] => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    const answers = server.batch(ops);
    for (const msg of answers) receive(room, msg);
    return answers;
  };
  return { clock, outbox, server, room, connect, deliver, state: () => room.store.getState() };
}

function receive(room: RoomStore, msg: ServerMessage): void {
  switch (msg.t) {
    case "snapshot":
      room.applySnapshot(msg);
      return;
    case "ev":
      room.applyEv(msg);
      return;
    case "retry":
      if (msg.n !== undefined) room.retryOps(msg.n);
      return;
    default:
      throw new Error(`unexpected ${msg.t}`);
  }
}

const damage = (tokenId: string, amount: number): ClientOp => ({ t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount } });
const move = (tokenId: string, x: number, y: number): ClientOp => ({ t: "token.move", tokenId, x, y });

function hpOf(view: RoomState | null, tokenId: string): number | undefined {
  const t = view?.tokens[tokenId];
  return t && "inline" in t.actor ? t.actor.inline.hp?.cur : undefined;
}

describe("snapshot and acknowledgment", () => {
  test("relative ops count once: before their ev only in pending, after it only in confirmed", () => {
    const s = setup(room({ tokens: { g1: token("g1", { actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 } }) } }) } }));
    s.connect();
    s.room.dispatch(damage("g1", 5));
    s.room.dispatch(damage("g1", 7));
    s.room.dispatch(damage("g1", 3));
    assert.equal(hpOf(s.state().view, "g1"), 15, "all three predicted at once");
    assert.deepEqual(s.outbox.sent.map((m) => (m.t === "op" ? m.n : 0)), [1, 2, 3]);

    // The server batches the first two. Its ev carries their changes and acks together.
    const sent = s.outbox.sent;
    s.outbox.sent = sent.slice(0, 2);
    s.deliver();
    s.outbox.sent = sent.slice(2);
    assert.equal(hpOf(s.state().confirmed as unknown as RoomState, "g1"), 18);
    assert.deepEqual(s.state().pending.map((p) => p.n), [3]);
    assert.equal(hpOf(s.state().view, "g1"), 15, "the third still replays on top, the first two never twice");

    s.deliver();
    assert.equal(s.state().pending.length, 0);
    assert.equal(hpOf(s.state().view, "g1"), 15);
    assert.deepEqual(s.state().view, projectState(s.server.state, DM, { sceneId: "s1" }), "the view equals a fresh projection");
  });

  test("a confirmed prediction keeps every object identity, so nothing re-renders", () => {
    const s = setup(room({ tokens: { g1: token("g1"), g2: token("g2") } }));
    s.connect();
    const before = s.state().view!;
    s.room.dispatch(move("g1", 7, 8));
    const predicted = s.state().view!;
    assert.notEqual(predicted.tokens.g1, before.tokens.g1);
    assert.equal(predicted.tokens.g2, before.tokens.g2, "untouched tokens keep their identity");
    assert.equal(predicted.scenes, before.scenes);
    s.deliver();
    const confirmed = s.state().view!;
    assert.equal(confirmed.tokens.g1, predicted.tokens.g1, "the server agreed: same object as the prediction");
    assert.equal(confirmed.tokens, predicted.tokens);
  });

  test("the trap logs stay lists when a second snapshot, as a DM's scene switch or a reconnect sends, brings their lines again", () => {
    const line = (id: string, type: "trap" | "trapSeen") => ({
      id,
      at: "2026-10-22T12:00:00.000Z",
      kind: "event" as const,
      data: type === "trap" ? { type, trapId: "t1", sceneId: "s1", name: "Hidden Pit", how: "enter" as const, by: ["g1"], hits: 1, did: [] } : { type, by: ["g1"], message: "The floor gives way!" },
    });
    const s = setup(room({ tokens: { g1: token("g1") }, trapLog: [line("4:900000", "trap")], trapSeen: [line("4:0", "trapSeen")] }));
    s.connect();
    const first = s.state().view!;
    // Off the wire, so every line is a new object equal to the one the view keeps.
    s.room.applySnapshot(JSON.parse(JSON.stringify(s.server.hello({ resumeFrom: s.room.prepareHello().resumeFrom, sceneId: "s1" }))));
    // Then a trap goes off: one new line in each log.
    s.room.applyEv({ t: "ev", seq: s.state().seq + 1, changes: [{ key: "trapLog:9:900000", value: line("9:900000", "trap") }, { key: "trapSeen:9:0", value: line("9:0", "trapSeen") }] });
    const view = s.state().view!;
    assert.ok(Array.isArray(view.trapLog), "the DM's trap log is still a list");
    assert.ok(Array.isArray(view.trapSeen), "the players' trap lines are still a list");
    assert.deepEqual(view.trapLog.map((e) => e.id), ["4:900000", "9:900000"]);
    assert.equal(view.trapLog[0], first.trapLog[0], "an equal line keeps its identity");
  });

  test("a refusal snaps the view back in the same update, with a toast unless it was a race", () => {
    const s = setup(room({ tokens: { g1: token("g1", { x: 3, y: 3 }) } }), P1);
    s.connect();
    s.room.dispatch(move("g1", 9, 9));
    assert.equal(s.state().view?.tokens.g1?.x, 9);
    const ev: Ev = { t: "ev", seq: 1, changes: [], rejects: [{ n: 1, code: "forbidden", message: "that is not yours" }] };
    s.room.applyEv(ev);
    assert.equal(s.state().view?.tokens.g1?.x, 3);
    assert.equal(s.state().pending.length, 0);
    assert.deepEqual(s.state().toasts.map((t) => t.text), ["That is not yours."]);

    s.room.dispatch(move("g1", 4, 4));
    s.room.applyEv({ t: "ev", seq: 2, changes: [], rejects: [{ n: 2, code: "gone", message: "that is not here" }] });
    assert.equal(s.state().toasts.length, 1, "gone means someone got there first: no toast");
    assert.deepEqual(s.state().refused, [1, 2], "for whatever offered to follow either up");
  });

  test("a pending op whose target vanished is skipped, and the rest still replay", () => {
    const s = setup(room({ tokens: { g1: token("g1"), g2: token("g2") } }));
    s.connect();
    s.outbox.open = false;
    s.room.dispatch(move("g1", 5, 5));
    s.room.dispatch(move("g2", 6, 6));
    s.room.applyEv({ t: "ev", seq: 1, changes: [{ key: "token:g1", deleted: true }] });
    assert.equal(s.state().view?.tokens.g1, undefined);
    assert.equal(s.state().view?.tokens.g2?.x, 6);
  });
});

describe("which ops are optimistic", () => {
  const fight = () =>
    room({
      tokens: { g1: token("g1"), pc: token("pc", { kind: "pc", ownerIds: ["p1"], actor: { ref: "c1" } }) },
      characters: { c1: character("c1") },
      encounter: {
        rev: 0,
        round: 1,
        activeEntryId: "e-pc",
        entries: [entry("e-pc", { tokenId: "pc", value: 15 }), entry("e-g1", { tokenId: "g1", value: 10 })],
      },
    });

  test("a player's End Turn scans the encounter, so it always waits for the server", () => {
    const s = setup(fight(), P1);
    s.connect();
    s.room.dispatch({ t: "encounter.next" });
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-pc", "not predicted");
    assert.equal(s.state().pending.length, 1);
    s.deliver();
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-g1", "applied when the ev lands");
  });

  test("the DM viewing the scene of every combatant predicts it", () => {
    const s = setup(fight(), DM);
    s.connect();
    s.room.dispatch({ t: "encounter.next" });
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-g1");
  });

  test("a double tap on the DM's Next moves the turn once, on this device and on the server", () => {
    const state = fight();
    state.tokens.g2 = token("g2");
    state.encounter!.entries.push(entry("e-g2", { tokenId: "g2", value: 5, tieOrder: 2 }));
    const s = setup(state, DM);
    s.connect();
    s.room.dispatch(turnOp("encounter.next", s.state()));
    s.room.dispatch(turnOp("encounter.next", s.state()));
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-g1", "the second tap is the same press");
    s.deliver();
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-g1");
    assert.equal(s.state().pending.length, 0);
    assert.deepEqual(s.state().toasts, [], "the late press is taken quietly");
    // Answered, the next press is a press of its own. Next then Previous before an answer both count.
    s.room.dispatch(turnOp("encounter.next", s.state()));
    s.room.dispatch(turnOp("encounter.prev", s.state()));
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-g1");
    s.deliver();
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-g1");
  });

  test("the DM viewing another scene than a combatant's waits", () => {
    const state = fight();
    state.tokens.g1 = token("g1", { sceneId: "s2" });
    const s = setup(state, DM, "s1");
    s.connect();
    s.room.dispatch({ t: "encounter.next" });
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-pc");
  });

  test("damage to a creature whose HP the player sees only as a label waits, with a spinner key", () => {
    const s = setup(room({ tokens: { g1: token("g1", { hpVisibility: "label" }) }, meta: { ...room().meta, settings: { ...room().meta.settings, playersApplyDamage: true } } }), P2);
    s.connect();
    s.room.dispatch(damage("g1", 4));
    assert.deepEqual(s.state().busy, { "token:g1": true });
    s.deliver();
    assert.deepEqual(s.state().busy, {});
  });

  test("a player moving a token they do not own is predicted from the projection", () => {
    const state = room({ tokens: { g1: token("g1") } });
    state.meta.settings.playersMoveAny = ["p1"];
    const s = setup(state, P1);
    s.connect();
    s.room.dispatch(move("g1", 8, 2));
    assert.equal(s.state().view?.tokens.g1?.x, 8);
    s.deliver();
    assert.equal(s.state().view?.tokens.g1?.x, 8);
    assert.equal(s.state().pending.length, 0);
  });

  test("undo always waits", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const before = s.state().view;
    s.room.dispatch({ t: "undo" });
    assert.equal(s.state().view, before);
  });

  test("a malformed op is never queued", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(s.room.dispatch(move("g1", 5000, 0)), null);
    } finally {
      console.error = original;
    }
    assert.equal(s.state().pending.length, 0);
    assert.equal(s.outbox.sent.length, 0);
  });
});

describe("which companion ops are optimistic (docs/design-v1-combat-flow.md 4.6)", () => {
  /** Bree (Ana, p1) on the players' scene with a spirit whose Reaction is spent, Cy (p2), and a goblin. */
  const party = () => {
    const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
    state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, x: 2, y: 2 });
    state.tokens.ws = token("ws", { kind: "npc", x: 3, y: 2, ownerIds: ["p1"], companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.tokens.g1 = token("g1", { x: 8, y: 8 });
    return state;
  };
  const spiritOp: ClientOp = {
    t: "token.create",
    token: { id: "owl", sceneId: "s1", kind: "npc", name: "Owl", size: "tiny", x: 1, y: 2, layer: "token", actor: { inline: actor({ hp: { cur: 1, max: 1, temp: 0 }, dmNotes: "" }) }, companion: { of: "bree", turn: "shared" } },
  };

  test("a player's companion create and turn change wait for the server, then land", () => {
    const s = setup(party(), P1);
    s.connect();
    s.room.dispatch(spiritOp);
    assert.equal(s.state().view?.tokens.owl, undefined, "not predicted");
    s.room.dispatch({ t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "none" } } });
    assert.equal(s.state().view?.tokens.ws?.companion?.turn, "shared", "not predicted");
    s.deliver();
    assert.ok(s.state().view?.tokens.owl?.companion);
    assert.equal(s.state().view?.tokens.ws?.companion?.turn, "none");
  });

  test("a companion's Reaction is predicted by a device that holds the token", () => {
    const s = setup(party(), P1);
    s.connect();
    s.room.dispatch({ t: "token.update", tokenId: "ws", patch: { companionReaction: false } });
    assert.equal(s.state().view?.tokens.ws?.companion?.reactionUsed, undefined, "cleared at once");
    s.deliver();
    assert.equal(s.state().pending.length, 0);
    assert.equal(s.state().view?.tokens.ws?.companion?.reactionUsed, undefined);
  });

  test("the DM's character owner change waits in a two-scene room, and is predicted in a one-scene room viewed whole", () => {
    const two = setup(party(), DM);
    two.connect();
    two.room.dispatch({ t: "character.update", characterId: "bree", patch: { ownerIds: ["p2"] } });
    assert.deepEqual(two.state().view?.tokens.ws?.ownerIds, ["p1"], "not predicted");
    two.deliver();
    assert.deepEqual(two.state().view?.tokens.ws?.ownerIds, ["p2"]);
    const single = party();
    delete single.scenes.s2;
    const one = setup(single, DM);
    one.connect();
    one.room.dispatch({ t: "character.update", characterId: "bree", patch: { ownerIds: ["p2"] } });
    assert.deepEqual(one.state().view?.tokens.ws?.ownerIds, ["p2"], "predicted");
  });

  test("the DM's Next onto a character-only row is predicted while the DM views the players' scene, and clears the spirit's Reaction", () => {
    const state = party();
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 20 }), entry("e-bree", { characterId: "bree", value: 10, tieOrder: 1 })] };
    const s = setup(state, DM, "s1");
    s.connect();
    s.room.dispatch({ t: "encounter.next" });
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-bree", "predicted");
    assert.equal(s.state().view?.tokens.ws?.companion?.reactionUsed, undefined);
    const away = setup(state, DM, "s2");
    away.connect();
    away.room.dispatch({ t: "encounter.next" });
    assert.equal(away.state().view?.encounter?.activeEntryId, "e-g1", "waits while the DM views another scene");
  });

  test("the DM's Next with a companion Reaction spent is predicted when the view holds every row's token", () => {
    const state = party();
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 20 }), entry("e-bree", { tokenId: "bt", value: 10, tieOrder: 1 })] };
    const s = setup(state, DM, "s1");
    s.connect();
    s.room.dispatch({ t: "encounter.next" });
    assert.equal(s.state().view?.encounter?.activeEntryId, "e-bree");
    assert.equal(s.state().view?.tokens.ws?.companion?.reactionUsed, undefined, "predicted with the turn");
    s.deliver();
    assert.equal(s.state().pending.length, 0);
    assert.equal(s.state().view?.tokens.ws?.companion?.reactionUsed, undefined);
  });
});

describe("which companion stat block ops are optimistic (docs/design-v1-companion-stat-blocks.md 4.4)", () => {
  /** Bree (Ana, p1) with her token and her owl Hoot on the players' scene, and one block she keeps. */
  const bree = () => {
    const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
    state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, x: 2, y: 2 });
    state.tokens.hoot = token("hoot", { kind: "npc", name: "Hoot", x: 3, y: 2, ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor({ dmNotes: "" }) } });
    state.companionBlocks.moth = companionBlock("moth", "bree");
    return state;
  };
  const newBlock = (id: string): ClientOp => {
    const { rev: _rev, ...block } = companionBlock(id, "bree", { name: "Owl" });
    return { t: "companionBlock.create", block };
  };

  test("a player's block create, edit and delete, and an attach with its numbers, show at once and land", () => {
    const s = setup(bree(), P1);
    s.connect();
    s.room.dispatch(newBlock("owl"));
    assert.equal(s.state().view?.companionBlocks.owl?.name, "Owl", "predicted");
    s.room.dispatch({ t: "companionBlock.update", blockId: "moth", patch: { ac: 15 } });
    assert.equal(s.state().view?.companionBlocks.moth?.ac, 15);
    s.room.dispatch({ t: "token.update", tokenId: "hoot", patch: { actor: { blockId: "owl", ac: 11, hp: { max: 1, cur: 1 } } } });
    const hoot = s.state().view?.tokens.hoot?.actor;
    assert.ok(hoot && "inline" in hoot && hoot.inline.blockId === "owl" && hoot.inline.ac === 11, "the attach is predicted");
    s.room.dispatch({ t: "companionBlock.delete", blockId: "moth" });
    assert.equal(s.state().view?.companionBlocks.moth, undefined);
    s.deliver();
    assert.equal(s.state().pending.length, 0);
    assert.equal(s.state().view?.companionBlocks.owl?.rev, 0, "the server's copy, rev 0 as a player's projection holds it");
    assert.equal(s.state().view?.companionBlocks.moth, undefined);
  });

  test("a new companion that carries a block waits for the server, as every companion create does", () => {
    const s = setup(bree(), P1);
    s.connect();
    s.room.dispatch({
      t: "token.create",
      token: { id: "owl", sceneId: "s1", kind: "npc", name: "Owl", size: "tiny", x: 1, y: 2, layer: "token", actor: { inline: actor({ hp: { cur: 1, max: 1, temp: 0 }, dmNotes: "", blockId: "moth" }) }, companion: { of: "bree", turn: "shared" } },
    });
    assert.equal(s.state().view?.tokens.owl, undefined, "not predicted");
    s.deliver();
    const owl = s.state().view?.tokens.owl?.actor;
    assert.ok(owl && "inline" in owl && owl.inline.blockId === "moth");
  });

  test("a save refused past the saves budget rolls back its prediction, and the moves queued after it are sent and taken in order", () => {
    const s = setup(bree(), P1);
    s.connect();
    const answers: OpAnswer[] = [];
    s.room.dispatch(newBlock("late"), { onAnswer: (a) => answers.push(a), quiet: true });
    s.room.dispatch(move("hoot", 4, 2));
    s.room.dispatch(move("hoot", 5, 2));
    assert.ok(s.state().view?.companionBlocks.late);
    assert.deepEqual(s.outbox.takeOps(), [1, 2, 3], "nothing waits behind the save");
    // The server refuses the save and takes the moves after it, in one batch, as the room actor answers a save past the budget.
    s.room.applyEv({ t: "ev", seq: 1, changes: [], acks: [2, 3], rejects: [{ n: 1, code: "quota", message: BLOCK_SAVES_TOO_FAST }] });
    assert.equal(s.state().view?.companionBlocks.late, undefined, "rolled back");
    assert.deepEqual(answers, ["refused"]);
    assert.deepEqual(s.state().toasts, [], "the editor that sent it says why");
    assert.equal(s.state().pending.length, 0);
    s.room.dispatch(move("hoot", 6, 2));
    assert.deepEqual(s.outbox.takeOps(), [4], "the device goes on sending at once");
  });
});

describe("undo answers", () => {
  const answer = (s: ReturnType<typeof setup>, extra: Partial<Ev>) =>
    s.room.applyEv({ t: "ev", seq: s.state().seq + 1, changes: [], ...extra });

  test("an undo or redo says what it took back", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const undo = s.room.dispatch({ t: "undo" })!;
    answer(s, { acks: [undo], restored: [{ n: undo, what: "moving Goblin 2" }] });
    const redo = s.room.dispatch({ t: "redo" })!;
    answer(s, { acks: [redo], restored: [{ n: redo, what: "moving Goblin 2" }] });
    // A resent undo the server had already settled comes back without its words.
    const again = s.room.dispatch({ t: "undo" })!;
    answer(s, { acks: [again] });
    assert.deepEqual(
      s.state().toasts.map((t) => [t.text, t.tone]),
      [
        ["Undid moving Goblin 2.", "info"],
        ["Redid moving Goblin 2.", "info"],
        ["Undid your last change.", "info"],
      ],
    );
  });

  test("a second undo that reads the same shows as a new toast, so each press visibly lands", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const first = s.room.dispatch({ t: "undo" })!;
    answer(s, { acks: [first], restored: [{ n: first, what: "moving Goblin 2" }] });
    const id = s.state().toasts[0]!.id;
    const second = s.room.dispatch({ t: "undo" })!;
    answer(s, { acks: [second], restored: [{ n: second, what: "moving Goblin 2" }] });
    assert.equal(s.state().toasts.length, 1);
    assert.notEqual(s.state().toasts[0]!.id, id);
  });

  test("a quiet undo, as Teleport here sends, shows no toast whatever its answer", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const taken = s.room.dispatch({ t: "undo", of: 3 }, { quiet: true })!;
    answer(s, { acks: [taken], restored: [{ n: taken, what: "moving Goblin 2" }] });
    const refused = s.room.dispatch({ t: "undo", of: 4 }, { quiet: true })!;
    answer(s, { rejects: [{ n: refused, code: "invalid", message: "could not undo that move: it is no longer your newest change" }] });
    assert.deepEqual(s.state().toasts, []);
    assert.equal(s.state().pending.length, 0);
  });

  test("a refused undo reads as its own sentence, never as an unsaved change", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const empty = s.room.dispatch({ t: "redo" })!;
    answer(s, { rejects: [{ n: empty, code: "invalid", message: "nothing to redo" }] });
    const changed = s.room.dispatch({ t: "undo" })!;
    answer(s, { rejects: [{ n: changed, code: "invalid", message: "could not undo moving Goblin 2: it was changed since" }] });
    assert.deepEqual(
      s.state().toasts.map((t) => [t.text, t.tone]),
      [
        ["Nothing to redo.", "info"],
        ["Could not undo moving Goblin 2: it was changed since.", "error"],
      ],
    );
  });
});

describe("retries and resends", () => {
  test("busy pauses sending, backs off, then resends every pending op in order", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch(move("g1", 1, 1));
    s.room.dispatch(move("g1", 2, 2));
    s.room.dispatch(move("g1", 3, 3));
    assert.deepEqual(s.outbox.takeOps(), [1, 2, 3]);
    s.room.retryOps(1);
    s.room.retryOps(2);
    s.room.dispatch(move("g1", 4, 4));
    assert.deepEqual(s.outbox.takeOps(), [], "nothing goes out while paused");
    s.clock.advance(249);
    assert.deepEqual(s.outbox.takeOps(), []);
    s.clock.advance(1);
    assert.deepEqual(s.outbox.takeOps(), [1, 2, 3, 4], "everything, oldest first, after 250 ms");
  });

  test("a gap after the resend backs off longer, and an ack resets the backoff", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch(move("g1", 1, 1));
    s.room.dispatch(move("g1", 2, 2));
    s.outbox.takeOps();
    s.room.retryOps(1);
    s.clock.advance(250);
    assert.deepEqual(s.outbox.takeOps(), [1, 2]);
    s.room.retryOps(2);
    s.clock.advance(499);
    assert.deepEqual(s.outbox.takeOps(), []);
    s.clock.advance(1);
    assert.deepEqual(s.outbox.takeOps(), [1, 2], "the second wait is 500 ms");
    s.room.applyEv({ t: "ev", seq: 1, changes: [], acks: [1] });
    s.room.retryOps(2);
    s.clock.advance(250);
    assert.deepEqual(s.outbox.takeOps(), [2], "progress resets the backoff to 250 ms");
  });

  test("the server's own gap answers drive a resend from the missing op", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch(move("g1", 1, 1));
    s.room.dispatch(move("g1", 2, 2));
    s.room.dispatch(move("g1", 3, 3));
    // The frame budget dropped op 1.
    s.outbox.sent = s.outbox.sent.filter((m) => !(m.t === "op" && m.n === 1));
    const answers = s.deliver();
    assert.deepEqual(answers.map((m) => (m.t === "retry" ? `${m.code}:${m.n}` : m.t)), ["gap:2", "gap:3"]);
    s.clock.advance(250);
    s.deliver();
    assert.equal(s.state().pending.length, 0);
    assert.equal(s.state().view?.tokens.g1?.x, 3);
  });

  test("an op with no answer for 10 s is resent with everything after it", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch(move("g1", 1, 1));
    s.clock.advance(4_000);
    s.room.dispatch(move("g1", 2, 2));
    assert.deepEqual(s.outbox.takeOps(), [1, 2]);
    s.clock.advance(OP_ANSWER_MS - 4_001);
    assert.deepEqual(s.outbox.takeOps(), []);
    s.clock.advance(1);
    assert.deepEqual(s.outbox.sent.map((m) => (m.t === "op" ? m.n : 0)), [1, 2]);
    s.deliver();
    s.clock.advance(OP_ANSWER_MS * 3);
    assert.deepEqual(s.outbox.takeOps(), [], "answered ops arm nothing");
    assert.equal(s.clock.pendingTimers, 0);
  });

  test("ops made while disconnected show at once and go out after the snapshot", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.suspend();
    s.room.dispatch(move("g1", 6, 6));
    assert.equal(s.state().view?.tokens.g1?.x, 6);
    assert.deepEqual(s.outbox.takeOps(), []);
    s.connect();
    assert.deepEqual(s.outbox.takeOps(), [1]);
  });
});

describe("reconnect", () => {
  test("the snapshot drops every pending op at or below the watermark and resends the rest", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.dispatch(move("g1", 1, 1));
    s.room.dispatch(move("g1", 2, 2));
    s.room.dispatch(move("g1", 3, 3));
    // Ops 1 and 2 commit, but the socket dies before their ev arrives.
    const sent = s.outbox.sent;
    s.outbox.sent = sent.slice(0, 2);
    s.server.batch(s.outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : [])));
    s.outbox.sent = [];
    s.room.suspend();
    const hello = s.room.prepareHello();
    assert.equal(hello.resumeFrom, 1);
    const snapshot = s.server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" });
    assert.equal(snapshot.watermark, 2);
    s.room.applySnapshot(snapshot);
    assert.deepEqual(s.state().pending.map((p) => p.n), [3]);
    assert.deepEqual(s.outbox.takeOps(), [3]);
    assert.equal(s.state().view?.tokens.g1?.x, 3);
  });

  test("ops older than 12 hours are dropped with a notice, and resumeFrom skips them", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.suspend();
    s.room.dispatch(move("g1", 1, 1));
    s.room.dispatch(move("g1", 2, 2));
    s.clock.advance(11 * 60 * 60 * 1000);
    s.room.dispatch(move("g1", 3, 3));
    s.clock.advance(MAX_OP_AGE_MS - 11 * 60 * 60 * 1000 + 1);
    const hello = s.room.prepareHello();
    assert.equal(hello.resumeFrom, 3);
    assert.deepEqual(s.state().pending.map((p) => p.n), [3]);
    assert.deepEqual(s.state().toasts.map((t) => t.text), ["2 offline edits were too old to save."]);

    s.clock.advance(MAX_OP_AGE_MS);
    assert.equal(s.room.prepareHello().resumeFrom, 4, "with nothing left, the next n");
    assert.equal(s.state().view?.tokens.g1?.x, 3, "dropped ops leave the view");
  });

  test("each op's sender hears what became of it: taken only when the server said so", () => {
    const s = setup(room({ tokens: { g1: token("g1", { actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } }) } }));
    s.connect();
    const answers = new Map<number, OpAnswer>();
    const send = (op: ClientOp) => {
      const n = s.room.dispatch(op, { onAnswer: (a) => answers.set(n, a) })!;
      return n;
    };
    const taken = send(damage("g1", 1));
    const refused = send(damage("nobody", 1));
    s.deliver();
    assert.deepEqual([answers.get(taken), answers.get(refused)], ["taken", "refused"]);
    // An area's damage the server refuses, then 20 moves, and every answer is lost with the socket.
    const lost = send(damage("nobody", 3));
    const moves = Array.from({ length: 20 }, (_, i) => send(move("g1", i + 1, 1)));
    s.server.batch(s.outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : [])));
    s.outbox.sent = [];
    s.room.suspend();
    s.room.applySnapshot(s.server.hello({ resumeFrom: s.room.prepareHello().resumeFrom, sceneId: "s1" }));
    assert.deepEqual(s.state().pending, []);
    assert.equal(answers.get(lost), "unknown", "the snapshot does not say it was refused");
    assert.ok(moves.every((n) => answers.get(n) === "unknown"), "nor which of the others applied");
  });

  test("a refused op's sender hears why, in the toast's own words", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    let heard: { answer: OpAnswer; refusal: OpRefusal | undefined } | undefined;
    s.room.dispatch(damage("nobody", 1), { quiet: true, onAnswer: (answer, refusal) => (heard = { answer, refusal }) });
    s.deliver();
    assert.equal(heard?.answer, "refused");
    assert.ok(heard?.refusal, "a refusal carries its reason");
    assert.equal(heard.refusal.text, refusalText(heard.refusal.code, heard.refusal.message));
    let taken: OpRefusal | undefined | null = null;
    s.room.dispatch(move("g1", 2, 2), { onAnswer: (_answer, refusal) => (taken = refusal) });
    s.deliver();
    assert.equal(taken, undefined, "a taken op has no reason");
  });

  test("an op too old to send is unknown to its sender", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.suspend();
    let answer: OpAnswer | undefined;
    s.room.dispatch(move("g1", 1, 1), { onAnswer: (a) => (answer = a) });
    s.clock.advance(MAX_OP_AGE_MS + 1);
    s.room.prepareHello();
    assert.equal(answer, "unknown");
  });

  test("an unknown answer says how it came about: expired while the hello was prepared, before any new snapshot, or settled by a snapshot already in the view (docs/design-v1-pdf-handouts.md 4.1.5)", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    const heard: { answer: OpAnswer; cause: UnknownCause | undefined; snapshots: number | undefined }[] = [];
    const listen = { onAnswer: (answer: OpAnswer, _refusal?: OpRefusal, cause?: UnknownCause) => heard.push({ answer, cause, snapshots: s.state().snapshots }) };
    const first = s.state().snapshots ?? 0;
    assert.ok(first >= 1, "connecting applied a snapshot");
    // Too old to send: dropped while the hello is prepared, before the snapshot that follows it.
    s.room.suspend();
    s.room.dispatch(move("g1", 1, 1), listen);
    s.clock.advance(MAX_OP_AGE_MS + 1);
    const hello = s.room.prepareHello();
    assert.deepEqual(heard, [{ answer: "unknown", cause: "expired", snapshots: first }]);
    s.room.applySnapshot(s.server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
    assert.equal(s.state().snapshots, first + 1);
    // Sent, then its answer lost with the socket: the next snapshot settles it, and is in the view when the sender hears.
    s.room.dispatch(move("g1", 2, 2), listen);
    s.server.batch(s.outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : [])));
    s.outbox.sent = [];
    s.room.suspend();
    s.room.applySnapshot(s.server.hello({ resumeFrom: s.room.prepareHello().resumeFrom, sceneId: "s1" }));
    assert.deepEqual(heard[1], { answer: "unknown", cause: "snapshot", snapshots: first + 2 });
    // A taken or refused answer carries no cause.
    s.room.dispatch(move("g1", 3, 3), listen);
    s.deliver();
    assert.deepEqual(heard[2], { answer: "taken", cause: undefined, snapshots: first + 2 });
  });

  test("a snapshot never lets the store reuse an n the server settled", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    const snapshot: Snapshot = { ...s.server.hello({ resumeFrom: 1, sceneId: "s1" }), watermark: 7 };
    s.room.applySnapshot(snapshot);
    assert.equal(s.room.dispatch(move("g1", 1, 1)), 8);
  });
});

describe("drag previews", () => {
  const preview = (s: ReturnType<typeof setup>) => s.state().ephemeral.drags["p2|g1"];

  test("start and move frames show, and 3 s without a frame clears", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.receiveEph("p2", { k: "dragStart", tokenId: "g1", x: 3, y: 3 });
    s.clock.advance(2_000);
    s.room.receiveEph("p2", { k: "dragMove", tokenId: "g1", x: 4.5, y: 3.2 });
    assert.deepEqual({ x: preview(s)?.x, y: preview(s)?.y, ended: preview(s)?.ended }, { x: 4.5, y: 3.2, ended: false });
    s.clock.advance(PREVIEW_IDLE_MS - 1);
    assert.ok(preview(s));
    s.clock.advance(1);
    assert.equal(preview(s), undefined);
    assert.equal(s.clock.pendingTimers, 0, "no timer left once nothing can expire");
  });

  test("dragCancel clears at once", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.receiveEph("p2", { k: "dragMove", tokenId: "g1", x: 4, y: 4 });
    s.room.receiveEph("p2", { k: "dragCancel", tokenId: "g1" });
    assert.equal(preview(s), undefined);
  });

  test("dragEnd holds the drop point until the ev moves the token, so it never flashes back", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.receiveEph("p2", { k: "dragMove", tokenId: "g1", x: 6, y: 6 });
    s.room.receiveEph("p2", { k: "dragEnd", tokenId: "g1", x: 6, y: 6 });
    assert.equal(preview(s)?.ended, true);
    const ev = s.server.external(move("g1", 6, 6), P2)!;
    s.room.applyEv(ev);
    assert.equal(preview(s), undefined);
    assert.equal(s.state().view?.tokens.g1?.x, 6);
  });

  test("a drop that never commits lets go after 1 s", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.receiveEph("p2", { k: "dragEnd", tokenId: "g1", x: 6, y: 6 });
    s.clock.advance(DRAG_END_HOLD_MS);
    assert.equal(preview(s), undefined);
  });

  test("presence loss, a removed token and a new snapshot each clear previews", () => {
    const s = setup(room({ tokens: { g1: token("g1"), g2: token("g2") } }));
    s.connect();
    s.room.receiveEph("p2", { k: "dragMove", tokenId: "g1", x: 4, y: 4 });
    s.room.setPresence(["dm1", "p1"]);
    assert.equal(preview(s), undefined, "p2 went offline");

    s.room.setPresence(["dm1", "p1", "p2"]);
    s.room.receiveEph("p2", { k: "dragMove", tokenId: "g2", x: 4, y: 4 });
    s.room.applyEv(s.server.external({ t: "token.delete", tokenId: "g2" }, DM)!);
    assert.equal(s.state().ephemeral.drags["p2|g2"], undefined, "the token was removed");

    s.room.receiveEph("p2", { k: "dragMove", tokenId: "g1", x: 4, y: 4 });
    s.connect();
    assert.equal(preview(s), undefined, "a snapshot replaces the state");
  });

  test("presence keeps how many table displays are open, none when the server leaves the count out", () => {
    const s = setup(room({ tokens: {} }));
    s.connect();
    s.room.setPresence(["dm1"], 2);
    assert.equal(s.state().displays, 2);
    s.room.setPresence(["dm1", "p1"]);
    assert.equal(s.state().displays, 0);
  });

  test("a preview of a token this view does not hold is ignored", () => {
    const s = setup(room({ tokens: {} }));
    s.connect();
    s.room.receiveEph("p2", { k: "dragMove", tokenId: "ghost", x: 4, y: 4 });
    assert.deepEqual(s.state().ephemeral.drags, {});
  });

  test("this device's own rulers never time out, and a reconnect to the same scene keeps them", () => {
    const s = setup(room({ tokens: { g1: token("g1") } }));
    s.connect();
    s.room.recordLocalEph({ k: "ruler", id: "r1", points: [{ x: 1, y: 1 }] });
    s.room.receiveEph("p2", { k: "ruler", id: "r2", points: [{ x: 2, y: 2 }], shared: true });
    s.clock.advance(PREVIEW_IDLE_MS * 2);
    assert.deepEqual(Object.keys(s.state().ephemeral.rulers), ["dm1|r1"]);
    s.room.receiveEph("p2", { k: "ruler", id: "r2", points: [{ x: 2, y: 2 }], shared: true });
    s.connect();
    assert.deepEqual(Object.keys(s.state().ephemeral.rulers), ["dm1|r1"]);
  });

  test("a look-here moves only players", () => {
    const dm = setup(room());
    dm.connect();
    dm.room.receiveEph("dm2", { k: "focus", x: 1, y: 2, zoom: 40 });
    assert.equal(dm.state().ephemeral.focus, null);
    const player = setup(room(), P1);
    player.connect();
    player.room.receiveEph("dm1", { k: "focus", x: 1, y: 2, zoom: 40 });
    assert.equal(player.state().ephemeral.focus?.zoom, 40);
  });
});

describe("phone sheets", () => {
  test("the list of panels counts as an open sheet, and opening a panel takes its place", () => {
    const t = setup(room());
    assert.equal(sheetOpen(t.state().local), false);
    t.room.ui.showPanelList(true);
    assert.equal(t.state().local.panelList, true);
    assert.equal(sheetOpen(t.state().local), true, "what floats over the map folds for the list too");
    t.room.ui.openPanel("log");
    assert.deepEqual([t.state().local.panelList, t.state().local.panel], [false, "log"]);
    assert.equal(sheetOpen(t.state().local), true);
    t.room.ui.closePanel();
    assert.equal(sheetOpen(t.state().local), false);
  });

  test("one close clears the list of panels or a panel, so what folded under it comes back", () => {
    const t = setup(room());
    t.room.ui.showPanelList(true);
    t.room.ui.closeSheets();
    assert.deepEqual([t.state().local.panelList, t.state().local.panel], [false, null], "the list alone, with no panel open");
    assert.equal(sheetOpen(t.state().local), false);
    t.room.ui.openPanel("party");
    t.room.ui.closeSheets();
    assert.equal(sheetOpen(t.state().local), false, "a panel");
    const before = t.state();
    t.room.ui.closeSheets();
    assert.equal(t.state(), before, "nothing open: no change, no render");
  });
});

describe("a sheet that fills the screen (docs/design-v1-sheet-swipe.md 4.7)", () => {
  test("every open starts at the normal height, and only the sheet's closing or its replacement ends it", () => {
    const t = setup(room());
    const expanded = () => t.state().local.sheetExpanded;
    t.room.ui.expandSheet(true);
    assert.equal(expanded(), false, "with no sheet there is nothing to fill");
    t.room.ui.openPanel("log");
    t.room.ui.expandSheet(true);
    assert.equal(expanded(), true);
    t.room.ui.openPanel("log");
    assert.equal(expanded(), true, "the same panel asked for again is no new open");
    t.room.ui.openPanel("journal");
    assert.equal(expanded(), false, "another panel opens at its normal height");
    t.room.ui.expandSheet(true);
    t.room.ui.closePanel();
    t.room.ui.openPanel("journal");
    assert.equal(expanded(), false, "not remembered after a close");
    t.room.ui.closeSheets();
    t.room.ui.showPanelList(true);
    t.room.ui.expandSheet(true);
    t.room.ui.openPanel("party");
    assert.equal(expanded(), false, "a full list, then a panel picked: the panel at its normal height");
    t.room.ui.expandSheet(true);
    t.room.ui.closeSheets();
    assert.equal(expanded(), false);
    t.room.ui.showPanelList(true);
    t.room.ui.expandSheet(true);
    t.room.ui.showPanelList(false);
    assert.equal(expanded(), false, "the list closed");
  });

  test("with a split kept from a wider layout, the phone's sheet keeps or loses it by the same rule: its panel replaced or not", () => {
    const kept: LocalUi = { ...INITIAL_LOCAL, panel: "log", tab: "log", below: "tracker", splitFits: false, sheetExpanded: true };
    assert.equal(withPanel(kept, "log").sheetExpanded, true, "the same panel asked for again");
    assert.equal(withPanel(kept, "journal").sheetExpanded, false, "another panel");
    assert.equal(withPanel(kept, "party", undefined, true).sheetExpanded, false, "a phone-only panel");
    assert.equal(withoutBelow(kept).sheetExpanded, true, "the bottom pane closed, the sheet's panel kept");
    assert.equal(withoutBelow({ ...kept, panel: "tracker" }).sheetExpanded, false, "the bottom pane closed while the sheet named it: the sheet's panel replaced");
  });

  test("a change of layout keeps it latent: Hide, a rotation and the crossing of 900 px", () => {
    const t = setup(room());
    t.room.ui.openPanel("log");
    t.room.ui.expandSheet(true);
    t.room.ui.hideSheet(true);
    t.room.ui.hideSheet(false);
    assert.equal(t.state().local.sheetExpanded, true, "Hide, sideways");
    t.room.ui.crossWide(true);
    t.room.ui.crossWide(false);
    assert.equal(t.state().local.sheetExpanded, true, "turned past 900 px and back");
    t.room.ui.expandSheet(false);
    assert.equal(t.state().local.sheetExpanded, false, "a step down");
    const before = t.state();
    t.room.ui.expandSheet(false);
    assert.equal(t.state(), before, "no change, no render");
  });
});

describe("hidden sheets and side panel", () => {
  test("a hidden sheet keeps its panel and covers nothing, and opening a panel shows it again", () => {
    const t = setup(room());
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], ["log", true]);
    assert.equal(sheetOpen(t.state().local), false, "what floats over the map comes back");
    t.room.ui.hideSheet(false);
    assert.equal(sheetOpen(t.state().local), true);
    t.room.ui.hideSheet(true);
    t.room.ui.openPanel("journal");
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], ["journal", false]);
  });

  test("with no panel open there is nothing to hide", () => {
    const t = setup(room());
    const before = t.state();
    t.room.ui.hideSheet(true);
    assert.equal(t.state(), before);
  });

  test("opening a panel clears both hidden states", () => {
    const t = setup(room());
    t.room.ui.hideSidePanel(true);
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    t.room.ui.openPanel("token");
    assert.deepEqual([t.state().local.sidePanelHidden, t.state().local.sheetHidden, t.state().local.tab], [false, false, "token"]);
  });

  test("closing clears the hidden sheet, and the list drops a hidden panel", () => {
    const t = setup(room());
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    t.room.ui.closeSheets();
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], [null, false]);
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    t.room.ui.closePanel();
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], [null, false]);
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    t.room.ui.showPanelList(true);
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden, t.state().local.panelList], [null, false, true], "the list takes the hidden panel's place");
  });

  test("closing the list leaves a hidden panel hidden", () => {
    const t = setup(room());
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    t.room.ui.showPanelList(false);
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], ["log", true]);
  });

  test("what the panels show, in each state", () => {
    const local = (patch: Partial<LocalUi>): LocalUi => ({ ...INITIAL_LOCAL, ...patch });
    assert.deepEqual(panelView(local({}), false), { panel: null, shown: false, list: false, tokenShown: false }, "no panel");
    assert.deepEqual(panelView(local({ panel: "token", tab: "token" }), false), { panel: "token", shown: true, list: false, tokenShown: true }, "a shown sheet");
    assert.deepEqual(panelView(local({ panel: "token", tab: "token", sheetHidden: true }), false), { panel: "token", shown: false, list: false, tokenShown: false }, "a hidden sheet");
    assert.deepEqual(panelView(local({ panelList: true }), false), { panel: null, shown: false, list: true, tokenShown: false }, "the list");
    assert.deepEqual(panelView(local({ tab: "token" }), true), { panel: "token", shown: true, list: false, tokenShown: true }, "wide, the side panel shown");
    assert.deepEqual(panelView(local({ tab: "token", sidePanelHidden: true }), true), { panel: "token", shown: false, list: false, tokenShown: false }, "wide, the side panel hidden");
    assert.deepEqual(panelView(local({ tab: "log" }), true), { panel: "log", shown: true, list: false, tokenShown: false }, "wide, another tab");
  });

  test("crossing 900 px with a hidden sheet: wide clears it, and back it stays shown", () => {
    const t = setup(room());
    t.room.ui.openPanel("log");
    t.room.ui.hideSheet(true);
    t.room.ui.crossWide(true);
    assert.deepEqual([t.state().local.sheetHidden, t.state().local.tab], [false, "log"], "the side panel shows that panel's tab");
    t.room.ui.crossWide(false);
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], ["log", false], "the side panel showed it, so the sheet shows");
  });

  test("crossing below 900 px with a hidden side panel opens its tab as a hidden sheet", () => {
    const t = setup(room());
    t.room.ui.openPanel("log");
    t.room.ui.hideSidePanel(true);
    t.room.ui.crossWide(false);
    assert.deepEqual([t.state().local.panel, t.state().local.sheetHidden], ["log", true], "a panel the viewer hid never pops up");
    assert.equal(sheetOpen(t.state().local), false);
    t.room.ui.crossWide(true);
    assert.deepEqual([t.state().local.sheetHidden, t.state().local.sidePanelHidden], [false, true], "wide again, the side panel keeps its own state");
    const before = t.state();
    t.room.ui.crossWide(true);
    assert.equal(t.state(), before, "no change, no render");
  });
});

describe("player scene", () => {
  test("a player's scene follows the room's player scene when an ev moves it", () => {
    const t = setup(room(), P1);
    t.connect();
    const before = t.state();
    assert.equal(before.sceneId, "s1");
    const meta = before.confirmed!.meta;
    const ev: Ev = { t: "ev", seq: before.seq + 1, changes: [{ key: "meta", value: { ...meta, playerSceneId: "s2" } }] };
    t.room.applyEv(ev);
    assert.equal(t.state().sceneId, "s2");
  });
});

describe("refusal toasts", () => {
  test("a scene at one of its caps says so in the scene's terms, and only a room-wide limit says the room is full", () => {
    const pillars = room();
    pillars.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} };
    for (let k = 0; k <= LIMITS.pillarsPerScene; k++) pillars.buildChunks["s1:0,0"].cells[`${k % 100},${Math.floor(k / 100)}`] = "pillar";
    const scene = checkLimits(pillars, "s1");
    assert.ok(!scene.ok);
    assert.equal(refusalText(scene.code, scene.message), `Not saved. This scene can hold at most ${LIMITS.pillarsPerScene.toLocaleString("en-US")} pillars.`);

    const scenes = room();
    for (let i = 0; i <= LIMITS.scenesPerRoom; i++) scenes.scenes[`x${i}`] = { ...scenes.scenes.s1!, id: `x${i}` };
    const whole = checkLimits(scenes);
    assert.ok(!whole.ok);
    assert.equal(refusalText(whole.code, whole.message), `Not saved. The room is full: it can hold at most ${LIMITS.scenesPerRoom} scenes.`);

    assert.equal(refusalText("quota", ""), "Not saved.");
    assert.equal(refusalText("invalid", "the token is gone."), "Not saved. The token is gone.");
  });
});
