import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { holderTileKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientMessage, ServerMessage } from "#shared/protocol.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { member, P1, room, scene } from "#shared/testutil.ts";
import { createFixtureState, FIXTURE_IDS } from "../../dev/fixture.ts";
import { api } from "../../lib/api.ts";
import { createRoomSocket, previewSocketUrl, type SocketLike } from "../../state/socket.ts";
import { createRoomStore } from "../../state/store.ts";
import { FakeClock } from "../../state/testing.ts";
import type { Ended } from "../../state/types.ts";
import { EMPTY_EPHEMERAL, INITIAL_LOCAL, type RoomView } from "../../state/types.ts";
import { createPreview, previewNotice, PREVIEW_LOAD_MS, watchPreviewLoad, type PreviewLoad } from "./preview.ts";

const { thorn, cave } = FIXTURE_IDS;

/** Thorn's own room as the server projects it for the preview socket. */
function playerView(): RoomState {
  return projectState(createFixtureState({ fog: "normal", blackout: false }), { memberId: thorn, role: "player" }, { sceneId: null }) as unknown as RoomState;
}

/** The preview socket's store once Thorn's snapshot is in. */
function source() {
  return createStore<RoomView>()(() => ({
    roomId: "DEVR00M0",
    you: { memberId: thorn, role: "player" },
    view: playerView(),
    sceneId: cave,
    connection: "open",
    online: [thorn],
    accessVersion: 0,
    ephemeral: EMPTY_EPHEMERAL,
    busy: {},
    toasts: [],
    ended: null,
    local: INITIAL_LOCAL,
    pending: [],
  }));
}

const byName = (view: RoomState, name: string) => Object.values(view.tokens).find((t) => t.name === name);

describe("view as a player (docs/design-v1-per-player-vision.md 7.4)", () => {
  test("follows the player's own store as the server sent it, and stays read-only", () => {
    const src = source();
    const preview = createPreview(src, thorn, { name: "Thorn" });
    try {
      const first = preview.store.getState();
      assert.deepEqual(first.you, { memberId: thorn, role: "player" });
      assert.equal(first.sceneId, cave);
      assert.equal(first.view, src.getState().view, "the server's projection as it came, never made again on the device");

      // A change the server sent shows up in the preview, and what did not change keeps its identity.
      const before = first.view!;
      const own = byName(src.getState().view!, "Thorn")!;
      const view = src.getState().view!;
      src.setState({ view: { ...view, tokens: { ...view.tokens, [own.id]: { ...own, x: own.x + 1 } } } });
      const after = preview.store.getState().view!;
      assert.equal(after.tokens[own.id]?.x, own.x + 1);
      assert.equal(after.characters, before.characters);
      const eph = { ...EMPTY_EPHEMERAL };
      src.setState({ ephemeral: eph });
      assert.equal(preview.store.getState().ephemeral, eph, "what the player's socket hears live, the preview shows");

      // Every action is refused locally, with one toast that says whispers between players are not shown.
      assert.equal(preview.actions.dispatch({ t: "log.chat", text: "hi" }), null);
      preview.actions.undo();
      assert.deepEqual(
        preview.store.getState().toasts.map((t) => t.text),
        ["You are viewing as Thorn. Nothing you do here is saved. Whispers between players are not shown."],
      );
      assert.equal(src.getState().toasts.length, 0);

      // Its own panels and selection.
      preview.ui.openPanel("log");
      assert.equal(preview.store.getState().local.panel, "log");
      assert.equal(src.getState().local.panel, null);

      // The socket's state shows, and what it held stays.
      src.setState({ connection: "reconnecting" });
      assert.equal(preview.store.getState().connection, "reconnecting");
      assert.ok(preview.store.getState().view);
    } finally {
      preview.dispose();
    }
    assert.equal(previewNotice(undefined), "You are viewing as a player. Nothing you do here is saved. Whispers between players are not shown.");
  });

  test("a dropped token snaps back, and the banner hears about it", async () => {
    const src = source();
    let refused = 0;
    const preview = createPreview(src, thorn, { onRefuse: () => refused++ });
    try {
      const thornToken = byName(preview.store.getState().view!, "Thorn")!;
      preview.actions.moveToken(thornToken.id, thornToken.x + 3, thornToken.y);
      assert.equal(preview.store.getState().view!.tokens[thornToken.id]?.x, thornToken.x + 3);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(preview.store.getState().view!.tokens[thornToken.id]?.x, thornToken.x);
      assert.equal(src.getState().view!.tokens[thornToken.id]?.x, thornToken.x, "the player's view never moved");
      assert.equal(refused, 1);
      assert.equal(preview.store.getState().toasts.length, 0);
    } finally {
      preview.dispose();
    }
  });

  test("through its socket, against a stubbed server: a per-player scene's own map, whatever scene the DM looks at, and nothing sent", () => {
    // p1 alone remembers a crypt with a label, which only the server's projection for p1 can show: the DM's view holds no player's map.
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
    s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: false, light: "dark", perPlayer: true } });
    s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] };
    const own = Object.values(rasterizeFogOps({}, "s1", s.scenes.s1.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }]))[0]!;
    s.exploredBy[holderTileKey("s1", "p1", own.tx, own.ty)] = { ...own, memberId: "p1" };
    s.labels.crypt = { id: "crypt", rev: 0, sceneId: "s1", x: 1.5, y: 1.5, text: "Crypt", size: 1 };

    const sent: ClientMessage[] = [];
    const sockets: (SocketLike & { readyState: number })[] = [];
    const clock = new FakeClock();
    const store = createRoomStore({ roomId: "R1", you: { memberId: "p1", role: "player" }, clock, random: () => 0.5, clientId: "preview" });
    const socket = createRoomSocket({
      url: previewSocketUrl("R1", "p1", { protocol: "https:", host: "vtt.example" }),
      room: store,
      clock,
      previewOf: "p1",
      frame: (cb) => cb(),
      createSocket: () => {
        const sock = { readyState: 0, send: (data: string) => void sent.push(JSON.parse(data) as ClientMessage), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null } as SocketLike & { readyState: number };
        sockets.push(sock);
        return sock;
      },
    });
    socket.start();
    const sock = sockets[0]!;
    sock.readyState = 1;
    sock.onopen?.({});
    const snapshot: ServerMessage = { t: "snapshot", seq: 0, state: projectState(s, P1, { sceneId: null }), you: { memberId: "p1", role: "player", sceneId: "s1" }, watermark: 0 };
    sock.onmessage?.({ data: JSON.stringify(snapshot) });
    const preview = createPreview(store.store, "p1", { name: "Pat" });
    try {
      assert.ok(preview.store.getState().view?.labels.crypt, "p1's own map, with the label only it holds");
      assert.equal(projectState(s, { memberId: "dm1", role: "dm" }, { sceneId: "s2" }).labels.crypt, undefined, "the DM on another scene holds none of it");
      assert.equal(preview.store.getState().sceneId, "s1");
      preview.actions.dispatch({ t: "log.chat", text: "hi" });
      preview.actions.sendEph({ k: "ping", x: 1, y: 1 });
      assert.deepEqual(sent.map((m) => m.t), ["hello"]);
    } finally {
      preview.dispose();
      socket.dispose();
      store.dispose();
    }
  });

  test("its older log pages are asked for as the player, as its socket is", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ entries: [], nextBefore: null }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await api.getLog("ABCD2345", { before: "9:0", as: "m 1" });
      await api.getLog("ABCD2345", { before: "9:0" });
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log?before=9%3A0&as=m+1", "/api/rooms/ABCD2345/log?before=9%3A0"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("its wait: loaded when the snapshot lands, failed after 10 s without one or once its socket ends, and failed stays, stopping the socket (7.4)", () => {
    const run = (steps: (src: ReturnType<typeof source>, clock: FakeClock) => void) => {
      const src = source();
      src.setState({ view: null });
      const clock = new FakeClock();
      const seen: PreviewLoad[] = [];
      let stops = 0;
      const wait = watchPreviewLoad(src, { clock, stop: () => stops++, onChange: (load) => seen.push(load) });
      steps(src, clock);
      const out = { seen, stops, load: wait.load };
      wait.dispose();
      return out;
    };
    const DENIED: Ended = { kind: "denied", code: 4003 };
    // No snapshot: failed at 10 s, not a moment before, and the socket stopped once.
    assert.deepEqual(
      run((_src, clock) => {
        clock.advance(PREVIEW_LOAD_MS - 1);
      }),
      { seen: [], stops: 0, load: "loading" },
    );
    assert.deepEqual(run((_src, clock) => clock.advance(PREVIEW_LOAD_MS)), { seen: ["failed"], stops: 1, load: "failed" });
    // A snapshot just in time loads, and the timer then changes nothing.
    assert.deepEqual(
      run((src, clock) => {
        clock.advance(PREVIEW_LOAD_MS - 1);
        src.setState({ view: playerView() });
        clock.advance(10_000);
      }),
      { seen: ["loaded"], stops: 0, load: "loaded" },
    );
    // A snapshot after the wait failed draws nothing.
    assert.deepEqual(
      run((src, clock) => {
        clock.advance(PREVIEW_LOAD_MS);
        src.setState({ view: playerView() });
      }),
      { seen: ["failed"], stops: 1, load: "failed" },
    );
    // A socket that ends, before or after its view, fails it.
    assert.deepEqual(run((src) => src.setState({ ended: DENIED })), { seen: ["failed"], stops: 1, load: "failed" });
    assert.deepEqual(
      run((src) => {
        src.setState({ view: playerView() });
        src.setState({ ended: DENIED });
      }),
      { seen: ["loaded", "failed"], stops: 1, load: "failed" },
    );
    // A store that already holds the view is loaded at once.
    const ready = source();
    const seen: PreviewLoad[] = [];
    const wait = watchPreviewLoad(ready, { clock: new FakeClock(), stop: () => {}, onChange: (load) => seen.push(load) });
    assert.deepEqual([seen, wait.load], [["loaded"], "loaded"]);
    wait.dispose();
  });
});
