import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ServerMessage } from "#shared/protocol.ts";
import { applyChanges, projectState, type ProjectedState } from "#shared/project.ts";
import { DM, P1, P2, room } from "#shared/testutil.ts";
import { LocalServer, localSocketFactory, previewOmits } from "./localServer.ts";

describe("the dev room's fan-out (client/dev/localServer.ts)", () => {
  test("keeps a player's live log as the room projects it when their whispers move where it starts", () => {
    const server = new LocalServer(room(), P1, "s1");
    let view = server.hello({ resumeFrom: 1, sceneId: "s1" }).state as ProjectedState;
    for (let i = 0; i < 70; i++) {
      // The DM chats, then whispers P1, so P1's whispers fill their ring and their live log starts later.
      for (const op of [{ t: "log.chat" as const, text: `c${i}` }, { t: "log.whisper" as const, to: ["p1"], text: `w${i}` }]) {
        const ev = server.external(op, DM);
        if (!ev) continue;
        const changed = ev.changes.map((c) => c.key);
        assert.deepEqual(changed, [...changed].sort(), "changes in key order, as the actor's fan-out sends them");
        view = applyChanges(view, ev.changes);
      }
    }
    const expected = projectState(server.state, P1, { sceneId: "s1" }).log;
    assert.ok(expected[0]!.kind === "whisper" && expected.length < 140, "the live log starts at P1's oldest kept whisper");
    assert.deepEqual(view.log, expected);
  });
});

/** P1's own projection less the whispers the DM is not party to: what the server's preview of P1 holds (server/rooms/fanout.ts buildSnapshot). */
function previewOfP1(server: LocalServer): ProjectedState {
  const viewed = projectState(server.state, P1, { sceneId: server.state.meta.playerSceneId });
  return { ...viewed, log: viewed.log.filter((line) => !previewOmits(line, DM.memberId)) };
}

describe("the dev room's View as a player (D-261026-10, docs/design-v1-per-player-vision.md 7.4)", () => {
  test("opens only for a DM and a player of the roster, as the server's `as` does", () => {
    const out = { send() {}, close() {} };
    assert.equal(new LocalServer(room(), P1, "s1").openPreview("p2", out), null, "a player's grant");
    const server = new LocalServer(room(), DM, "s1");
    assert.equal(server.openPreview("dm1", out), null, "a DM of the roster");
    assert.equal(server.openPreview("nobody", out), null, "an unknown id");
    assert.notEqual(server.openPreview("p1", out), null, "a player of the roster");
  });

  test("is that player's own view less whispers between players, in its snapshot and every batch after, and takes no acks", () => {
    const server = new LocalServer(room(), DM, "s2");
    server.hello({ resumeFrom: 1, sceneId: "s2" });
    const sent: ServerMessage[] = [];
    const closed: number[] = [];
    const preview = server.openPreview("p1", { send: (msg) => sent.push(msg), close: (code) => closed.push(code) })!;
    // Whispers each way before it opens, so the snapshot meets them too.
    server.external({ t: "log.whisper", to: ["p2"], text: "p1 to p2, before" }, P1);
    server.external({ t: "log.whisper", to: ["p1"], text: "the DM to p1, before" }, DM);
    const snapshot = preview.hello()!;
    assert.deepEqual(snapshot.you, { memberId: "p1", role: "player", sceneId: "s1" }, "the player's own scene, not the DM's");
    assert.deepEqual(snapshot.state, previewOfP1(server));
    const texts = (view: ProjectedState) => view.log.map((line) => line.text ?? "");
    assert.ok(texts(snapshot.state as ProjectedState).includes("the DM to p1, before"));
    assert.ok(!texts(snapshot.state as ProjectedState).includes("p1 to p2, before"), "a whisper between players in the snapshot");

    let view = snapshot.state as ProjectedState;
    let n = 1;
    const steps: [string, () => void][] = [
      ["a whisper from p1 to p2", () => server.external({ t: "log.whisper", to: ["p2"], text: "p1 to p2" }, P1)],
      ["a whisper from p2 to p1", () => server.external({ t: "log.whisper", to: ["p1"], text: "p2 to p1" }, P2)],
      ["a whisper from p1 to the DM", () => server.external({ t: "log.whisper", to: ["dm1"], text: "p1 to the DM" }, P1)],
      ["the DM's own batch", () => void server.batch([{ n: n++, op: { t: "log.chat", text: "the DM's chat" } }])],
      ["the DM's whisper to p1 and p2", () => void server.batch([{ n: n++, op: { t: "log.whisper", to: ["p1", "p2"], text: "the DM to both" } }])],
    ];
    for (const [what, step] of steps) {
      sent.length = 0;
      step();
      for (const msg of sent) {
        assert.equal(msg.t, "ev", what);
        if (msg.t !== "ev") continue;
        assert.equal(msg.acks, undefined, `${what}: the preview took an ack`);
        view = applyChanges(view, msg.changes);
      }
      assert.deepEqual(view, previewOfP1(server), what);
    }
    assert.deepEqual(texts(view).filter((t) => !t.endsWith("before")), ["p1 to the DM", "the DM's chat", "the DM to both"]);
    assert.deepEqual(closed, []);
  });

  test("follows its player to a new scene with a resync, and closes with 4003 once they leave the roster", () => {
    const server = new LocalServer(room(), DM, "s1");
    const sent: ServerMessage[] = [];
    const closed: number[] = [];
    const preview = server.openPreview("p1", { send: (msg) => sent.push(msg), close: (code) => closed.push(code) })!;
    preview.hello();
    server.external({ t: "room.setPlayerScene", sceneId: "s2" }, DM);
    assert.deepEqual(sent.at(-1), { t: "resync", reason: "scene" });
    assert.equal(preview.hello()!.you.sceneId, "s2");
    server.external({ t: "sys.memberRemove", memberId: "p1" }, DM);
    assert.deepEqual(closed, [4003]);
    sent.length = 0;
    server.external({ t: "log.chat", text: "after" }, DM);
    assert.deepEqual(sent, [], "a closed preview heard a batch");
  });

  test("its socket sends nothing but hello and ping, anything else closes it with 4003, and a refused one never opens", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = new LocalServer(room(), DM, "s1");
    const sockets = localSocketFactory({ server, latencyMs: 0, members: () => ["dm1"] });
    // Closing and delivering a snapshot each queue another timer. A wall-clock
    // sleep can finish before that timer when the connection's turn runs late.
    const settle = () => {
      t.mock.timers.tick(100);
      t.mock.timers.tick(1);
    };
    const open = (as: string) => {
      const socket = sockets.create(`ws://local/ws?room=DEVR00M0&as=${as}`);
      const got: ServerMessage[] = [];
      const closes: number[] = [];
      socket.onmessage = (e) => got.push(JSON.parse(e.data as string) as ServerMessage);
      socket.onclose = (e) => closes.push(e.code);
      settle();
      return { socket, got, closes };
    };

    const refused = open("dm1");
    assert.deepEqual(refused.closes, [1006], "a preview of the DM opened");

    const preview = open("p1");
    assert.equal(preview.socket.readyState, 1);
    preview.socket.send(JSON.stringify({ t: "hello", clientId: "c", resumeFrom: 1 }));
    preview.socket.send(JSON.stringify({ t: "ping", k: 7 }));
    settle();
    const snapshot = preview.got.find((m) => m.t === "snapshot");
    assert.ok(snapshot && snapshot.t === "snapshot" && snapshot.you.memberId === "p1" && snapshot.you.role === "player");
    assert.ok(preview.got.some((m) => m.t === "pong" && m.k === 7));
    // The DM's own socket still gets what it gets, and the preview only its player's view.
    sockets.push({ t: "eph", from: "dm1", e: { k: "ping", x: 1, y: 1 } });
    settle();
    assert.equal(preview.got.filter((m) => m.t === "eph").length, 0, "the DM's frames reached the preview");
    preview.socket.send(JSON.stringify({ t: "op", n: 1, op: { t: "log.chat", text: "from the preview" } }));
    settle();
    assert.deepEqual(preview.closes, [4003]);
    assert.equal(server.state.log.some((line) => line.text === "from the preview"), false, "the preview's op applied");

    for (const msg of [{ t: "scene", sceneId: "s2" }, { t: "hello", clientId: "c", resumeFrom: 1, as: "p1" }]) {
      const again = open("p1");
      again.socket.send(JSON.stringify(msg));
      settle();
      assert.deepEqual(again.closes, [4003], `${msg.t} closes it`);
    }
  });

  test("a late snapshot is built when its delay ends, so a chat sent meanwhile is in it and no event comes before it (review PV5-ASTRA-2)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const as of ["p1", null]) {
      const server = new LocalServer(room(), DM, "s1");
      const sockets = localSocketFactory({ server, latencyMs: 0, snapshotDelayMs: 150, members: () => ["dm1"] });
      const socket = sockets.create(as === null ? "local" : `ws://local/ws?room=DEVR00M0&as=${as}`);
      const got: ServerMessage[] = [];
      socket.onmessage = (e) => got.push(JSON.parse(e.data as string) as ServerMessage);
      t.mock.timers.tick(60);
      socket.send(JSON.stringify({ t: "hello", clientId: "c", resumeFrom: 1 }));
      t.mock.timers.tick(40);
      server.external({ t: "log.chat", text: "during the wait" }, DM);
      t.mock.timers.tick(110);
      t.mock.timers.tick(1);
      const kinds = got.map((m) => m.t).filter((t) => t !== "presence");
      assert.equal(kinds[0], "snapshot", `${as ?? "the room's socket"}: ${kinds.join(", ")}`);
      const snapshot = got.find((m) => m.t === "snapshot");
      assert.ok(snapshot?.t === "snapshot" && (snapshot.state as ProjectedState).log.some((line) => line.text === "during the wait"), `${as ?? "the room's socket"}: the snapshot lacks the chat sent while it waited`);
      socket.close();
      t.mock.timers.tick(1);
    }
  });

  test("a socket closed before it connects never opens, and registers no preview (review PV5-ASTRA-4)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = new LocalServer(room(), DM, "s1");
    const sockets = localSocketFactory({ server, latencyMs: 0, members: () => ["dm1"] });
    const socket = sockets.create("ws://local/ws?room=DEVR00M0&as=p1");
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onclose = () => events.push("close");
    socket.close();
    t.mock.timers.tick(60);
    assert.deepEqual(events, ["close"]);
    assert.equal(socket.readyState, 3);
    assert.equal((server as unknown as { previews: Set<unknown> }).previews.size, 0, "a preview was registered for a closed socket");
  });
});
