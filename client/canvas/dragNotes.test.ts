import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { holderTileKey } from "#shared/keys.ts";
import { projectState, withheldWhereItStands } from "#shared/project.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { DM, P1, P2, reveal, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomStore } from "../state/store.ts";
import { FakeClock, FakeOutbox } from "../state/testing.ts";
import { droppedIntoFog, intoFogText, refusedDragText, watchDrop } from "./dragNotes.ts";

describe("a drag that cannot move a token says why", () => {
  test("a player pressing someone else's token, and anyone on a locked one", () => {
    assert.equal(refusedDragText({ name: "Goblin 2", role: "player", owns: false, locked: false, moveAny: false }), "You can only move your own tokens.");
    assert.equal(refusedDragText({ name: "Goblin 2", role: "player", owns: false, locked: true, moveAny: false }), "You can only move your own tokens.");
    assert.equal(refusedDragText({ name: "Thorn", role: "player", owns: true, locked: true, moveAny: false }), "Thorn is locked in place.");
    assert.equal(refusedDragText({ name: "Door", role: "dm", owns: false, locked: true, moveAny: false }), "Door is locked. Turn off Locked in its action bar to move it.");
  });

  test("nothing to say when the drag is allowed", () => {
    assert.equal(refusedDragText({ name: "Thorn", role: "player", owns: true, locked: false, moveAny: false }), null);
    assert.equal(refusedDragText({ name: "Goblin", role: "player", owns: false, locked: false, moveAny: true }), null);
    assert.equal(refusedDragText({ name: "Goblin", role: "dm", owns: false, locked: false, moveAny: false }), null);
  });
});

describe("a token a player drops into the fog", () => {
  const setup = () => {
    const state = room();
    state.scenes.s1!.fogEnabled = true;
    reveal(state, "s1", { x: 0, y: 0, w: 6, h: 6 });
    return state;
  };

  test("is named when it lands fully fogged and the player neither owns it nor sees it through the fog", () => {
    const state = setup();
    const gob = { ...token("gob", { x: 2, y: 2 }), aboveFog: false };
    const into = (x: number, y: number, extra: { owns?: boolean; role?: "dm" | "player"; aboveFog?: boolean } = {}) =>
      droppedIntoFog({
        role: extra.role ?? "player",
        view: state,
        moves: [{ token: { ...gob, aboveFog: extra.aboveFog ?? false }, owns: extra.owns ?? false, x, y }],
      }).map((t) => t.id);
    assert.deepEqual(into(20, 20), ["gob"]);
    assert.deepEqual(into(3, 3), [], "still in the light");
    assert.deepEqual(into(5, 5), [], "one cell still lit");
    assert.deepEqual(into(20, 20, { owns: true }), [], "the party never vanishes");
    assert.deepEqual(into(20, 20, { aboveFog: true }), [], "exempt from the fog");
    assert.deepEqual(into(20, 20, { role: "dm" }), [], "the DM sees through the fog");
  });

  test("nothing vanishes on a scene without fog", () => {
    const state = setup();
    state.scenes.s1!.fogEnabled = false;
    const gob = { ...token("gob"), aboveFog: false };
    assert.deepEqual(droppedIntoFog({ role: "player", view: state, moves: [{ token: gob, owns: false, x: 20, y: 20 }] }), []);
  });

  test("on a vision scene, is left to the server's answer", () => {
    const state = setup();
    state.scenes.s1!.vision = { on: true, light: "dark" };
    const gob = { ...token("gob"), aboveFog: false };
    assert.deepEqual(droppedIntoFog({ role: "player", view: state, moves: [{ token: gob, owns: false, x: 20, y: 20 }] }), []);
  });

  test("on a per-player scene with fog alone, is judged by the player's own fog, so ground only they remember keeps it (docs/design-v1-per-player-vision.md 6.6)", () => {
    const state = setup();
    state.scenes.s1!.vision = { on: false, light: "dark", perPlayer: true };
    state.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] };
    const own = Object.values(rasterizeFogOps({}, "s1", state.scenes.s1!.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 10, y: 0, w: 6, h: 6 } }]))[0]!;
    state.exploredBy[holderTileKey("s1", "p1", own.tx, own.ty)] = { ...own, memberId: "p1" };
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    const dropAt = (viewer: typeof P1, x: number) => {
      const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
      return droppedIntoFog({ role: "player", view, moves: [{ token: { ...view.tokens.gob!, aboveFog: false }, owns: false, x, y: 2 }] }).map((t) => t.id);
    };
    assert.deepEqual(dropAt(P1, 12), [], "on ground p1 alone remembers, p1 still sees it");
    assert.deepEqual(dropAt(P1, 30), ["gob"]);
    assert.deepEqual(dropAt(P2, 12), ["gob"], "p2 does not remember that ground");
    assert.deepEqual(dropAt(P2, 3), [], "ground every player shares");
  });

  test("the note names one creature or counts several", () => {
    assert.equal(intoFogText([]), null);
    assert.equal(intoFogText(["Goblin 2"]), "Goblin 2 is in the fog now, so you can no longer see it.");
    assert.equal(intoFogText(["Goblin 2", "Goblin 3"]), "2 creatures are in the fog now, so you can no longer see them.");
    assert.equal(intoFogText(["Goblin 2"], "party"), "Goblin 2 is out of the party's sight now.");
    assert.equal(intoFogText(["Goblin 2", "Goblin 3"], "party"), "2 creatures are out of the party's sight now.");
    // On a per-player scene (docs/design-v1-per-player-vision.md 11).
    assert.equal(intoFogText(["Goblin"], "yours"), "Goblin is out of your sight now.");
    assert.equal(intoFogText(["Goblin", "Goblin 2", "Goblin 3"], "yours"), "3 creatures are out of your sight now.");
  });
});

/**
 * A player's room store against the dev fixture's server, which projects
 * with the server's own rules, so the party's sight after a move is worked
 * out the way the room actor works it out. An open dark scene with party
 * vision: Thorn's torch lights 8 squares around (3, 2), a goblin stands in
 * it, and another carries a lantern of its own.
 */
function darkTable() {
  const state = room();
  state.meta.settings.playersMoveAny = "all";
  state.scenes.s1!.vision = { on: true, light: "dark" };
  state.tokens.pc = token("pc", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 3, y: 2, light: { bright: 20, dim: 20 } });
  state.tokens.gob = token("gob", { name: "Goblin", x: 5, y: 2 });
  state.tokens.lamp = token("lamp", { name: "Lantern goblin", x: 6, y: 2, light: { bright: 5, dim: 5 } });
  const server = new LocalServer(structuredClone(state), P1, "s1");
  const outbox = new FakeOutbox();
  const store = createRoomStore({ roomId: "R1", you: P1, clock: new FakeClock(), random: () => 0.5, clientId: "c1" });
  store.setOutbox(outbox);
  store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom }));
  const notes: string[] = [];

  /** Drops tokens as the canvas does: a watch, then the moves sent with their answers going to it. */
  const begin = (moves: { id: string; x: number; y: number }[]) => {
    const view = store.store.getState().view!;
    const dropped = moves.map((m) => ({ token: view.tokens[m.id]!, owns: m.id === "pc", x: m.x, y: m.y }));
    const op: ClientOp = moves.length === 1 ? { t: "token.move", tokenId: moves[0]!.id, x: moves[0]!.x, y: moves[0]!.y } : { t: "token.moveMany", moves: moves.map((m) => ({ tokenId: m.id, x: m.x, y: m.y })) };
    const watch = watchDrop({ role: "player", store: store.store, moves: dropped, notify: (text) => notes.push(text) });
    assert.ok(watch, "a drop on a vision scene is watched");
    const n = store.dispatch(op, { onAnswer: (answer) => watch.answer(op, answer) });
    assert.ok(n !== null);
    watch.sent(1);
  };
  /** The server takes the ops the store sent, in one batch, and its answers come back. */
  const deliver = () => {
    const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
    outbox.sent = [];
    for (const msg of server.batch(ops)) if (msg.t === "ev") store.applyEv(msg);
  };
  /** The DM does something first, and the player hears of it before their move is processed. */
  const dmFirst = (op: Op) => {
    const ev = server.external(op, DM);
    if (ev && outbox.open) store.applyEv(ev);
  };
  /** The socket comes back, or the server asked for a fresh hello: a new snapshot, then the held ops again. */
  const rejoin = () => {
    outbox.open = true;
    store.suspend();
    store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom }));
  };
  const drop = (moves: { id: string; x: number; y: number }[]) => {
    begin(moves);
    const early = [...notes];
    deliver();
    return { early, notes, view: store.store.getState().view! };
  };
  return { begin, deliver, dmFirst, rejoin, drop, notes, outbox, view: () => store.store.getState().view! };
}

describe("a creature a player drops on a per-player vision scene (docs/design-v1-per-player-vision.md 11)", () => {
  test("is named out of their own sight, once the server took the move and no longer sends it", () => {
    const state = room();
    state.scenes.s1!.vision = { on: true, light: "dark", perPlayer: true };
    state.tokens.gob = token("gob", { name: "Goblin", x: 5, y: 2 });
    state.tokens.gob2 = token("gob2", { name: "Goblin", number: 2, x: 6, y: 2 });
    let view: RoomState = state;
    const listeners = new Set<() => void>();
    const store = { getState: () => ({ view }), subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
    const notes: string[] = [];
    const moves = ["gob", "gob2"].map((id) => ({ token: { ...state.tokens[id]!, aboveFog: false }, owns: false, x: 30, y: 20 }));
    const watch = watchDrop({ role: "player", store, moves, notify: (text) => notes.push(text) })!;
    const op: ClientOp = { t: "token.moveMany", moves: [{ tokenId: "gob", x: 30, y: 20 }, { tokenId: "gob2", x: 30, y: 20 }] };
    watch.sent(1);
    const { gob: _a, gob2: _b, ...rest } = state.tokens;
    view = { ...state, tokens: rest };
    for (const l of listeners) l();
    watch.answer(op, "taken");
    assert.deepEqual(notes, ["2 creatures are out of your sight now."]);
  });
});

describe("a creature a player drops on a vision scene", () => {
  test("is named once the server took the move and no longer sends it, when it lands out of the party's sight", () => {
    const t = darkTable();
    const out = t.drop([{ id: "gob", x: 30, y: 20 }]);
    assert.deepEqual(out.early, [], "nothing is said before the server answers");
    assert.deepEqual(out.notes, ["Goblin is out of the party's sight now."]);
    assert.equal(out.view.tokens.gob, undefined);
  });

  test("is not named when it carries its own light into the dark, which the party sees by", () => {
    const t = darkTable();
    const before = t.view();
    // The sight the player held at the drop says the far spot is dark: its lantern lit only where it stood.
    assert.equal(withheldWhereItStands(before, { ...before.tokens.lamp!, x: 25, y: 2 }), true);
    const out = t.drop([{ id: "lamp", x: 25, y: 2 }]);
    assert.deepEqual(out.notes, []);
    assert.ok(out.view.tokens.lamp, "the server still sends the lantern goblin");
  });

  test("is not named when the same drop carries the party's torch along", () => {
    const t = darkTable();
    const before = t.view();
    assert.equal(withheldWhereItStands(before, { ...before.tokens.gob!, x: 25, y: 12 }), true, "out of the torch's old reach");
    const out = t.drop([
      { id: "pc", x: 23, y: 12 },
      { id: "gob", x: 25, y: 12 },
    ]);
    assert.deepEqual(out.notes, []);
    assert.ok(out.view.tokens.gob, "the goblin moved with the torch");
  });

  test("is not named when the DM hid it before its move was processed, which the server refuses", () => {
    const t = darkTable();
    t.begin([{ id: "gob", x: 30, y: 20 }]);
    t.dmFirst({ t: "token.update", tokenId: "gob", patch: { visibility: "dm" } });
    t.deliver();
    assert.equal(t.view().tokens.gob, undefined, "gone, because it is hidden");
    assert.deepEqual(t.notes, []);
  });

  test("is not named when the players are moved to another scene before the move is answered", () => {
    const t = darkTable();
    t.begin([{ id: "gob", x: 30, y: 20 }]);
    t.dmFirst({ t: "room.setPlayerScene", sceneId: "s2" });
    t.rejoin();
    t.deliver();
    assert.equal(t.view().tokens.gob, undefined, "gone, because the view covers the other scene");
    assert.deepEqual(t.notes, []);
  });

  test("is not named when an offline drop comes back onto a new player scene", () => {
    const t = darkTable();
    t.outbox.open = false;
    t.begin([{ id: "gob", x: 30, y: 20 }]);
    t.dmFirst({ t: "room.setPlayerScene", sceneId: "s2" });
    t.rejoin();
    t.deliver();
    assert.equal(t.view().meta.playerSceneId, "s2");
    assert.deepEqual(t.notes, []);
  });

  test("is not named when a blackout begins before the move is answered", () => {
    const t = darkTable();
    t.begin([{ id: "gob", x: 30, y: 20 }]);
    t.dmFirst({ t: "view.blackout", blackout: true });
    t.deliver();
    assert.deepEqual(t.notes, []);
  });

  test("nothing is watched for the DM, whose view keeps every creature", () => {
    const t = darkTable();
    const view = t.view();
    const store = { getState: () => ({ view }), subscribe: () => () => {} };
    assert.equal(watchDrop({ role: "dm", store, moves: [{ token: view.tokens.gob!, owns: false, x: 30, y: 20 }], notify: () => {} }), null);
  });
});
