import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OpAnswer } from "../../state/types.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { createThumbWatch, makeThumbnail, type ThumbDeps } from "./thumbs.ts";

function view(...sceneIds: string[]): RoomState {
  return { scenes: Object.fromEntries(sceneIds.map((id) => [id, { id }])) } as unknown as RoomState;
}

const dm = { memberId: "m", role: "dm" as const };
const paint = (sceneId: string): ClientOp => ({ t: "build.paint", sceneId, terrain: "stone", cells: ["0,0"] });

describe("when a thumbnail is drawn", () => {
  test("leaving a scene this device changed hands back the view that still holds it", () => {
    const w = createThumbWatch();
    const a = view("a", "b");
    assert.equal(w.observe({ you: dm, sceneId: "a", view: a, pending: [] }), null);
    const edited = view("a", "b");
    assert.equal(w.observe({ you: dm, sceneId: "a", view: edited, pending: [{ n: 1, op: paint("a"), at: 0 }] }), null);
    assert.ok(w.changed("a"));
    // The snapshot of b replaces the view: the one before it still holds a.
    const left = w.observe({ you: dm, sceneId: "b", view: view("a", "b"), pending: [] });
    assert.equal(left?.sceneId, "a");
    assert.equal(left?.room, edited);
  });

  test("a copy of a scene this device changed is marked too, so leaving the copy draws its own thumbnail", () => {
    const w = createThumbWatch();
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending: [{ n: 1, op: paint("a"), at: 0 }] });
    const duplicate: ClientOp = { t: "scene.duplicate", sceneId: "a", newSceneId: "c", name: "A (copy)", include: { creatures: true, characters: false, fog: false, drawings: false } };
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending: [{ n: 2, op: duplicate, at: 0 }] });
    assert.ok(w.changed("c"));
    // The copy opens: the original is drawn as it is left.
    assert.equal(w.observe({ you: dm, sceneId: "c", view: view("a", "c"), pending: [] })?.sceneId, "a");
    // The copy carried the original's old picture. Leaving it draws its own.
    assert.equal(w.observe({ you: dm, sceneId: "a", view: view("a", "c"), pending: [] })?.sceneId, "c");
  });

  test("a copy of a scene this device has not changed keeps the original's thumbnail", () => {
    const w = createThumbWatch();
    const duplicate: ClientOp = { t: "scene.duplicate", sceneId: "a", newSceneId: "c", name: "A (copy)", include: { creatures: true, characters: false, fog: false, drawings: false } };
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending: [{ n: 1, op: duplicate, at: 0 }] });
    assert.equal(w.changed("c"), false);
    assert.equal(w.observe({ you: dm, sceneId: "c", view: view("a", "c"), pending: [] }), null);
    assert.equal(w.observe({ you: dm, sceneId: "a", view: view("a", "c"), pending: [] }), null);
  });

  test("a scene left unchanged, or changed only in ways a thumbnail does not show, is not drawn", () => {
    const w = createThumbWatch();
    w.observe({ you: dm, sceneId: "a", view: view("a", "b"), pending: [{ n: 1, op: { t: "scene.update", sceneId: "a", patch: { name: "Crypt" } }, at: 0 }] });
    assert.equal(w.observe({ you: dm, sceneId: "b", view: view("a", "b"), pending: [] }), null);
  });

  test("a player's view and a deleted scene draw nothing", () => {
    const player = createThumbWatch();
    player.observe({ you: { memberId: "p", role: "player" }, sceneId: "a", view: view("a"), pending: [{ n: 1, op: paint("a"), at: 0 }] });
    assert.equal(player.observe({ you: { memberId: "p", role: "player" }, sceneId: "b", view: view("b"), pending: [] }), null);

    const w = createThumbWatch();
    w.observe({ you: dm, sceneId: "a", view: view("a", "b"), pending: [{ n: 1, op: paint("a"), at: 0 }] });
    w.observe({ you: dm, sceneId: "a", view: view("b"), pending: [] });
    assert.equal(w.observe({ you: dm, sceneId: "b", view: view("b"), pending: [] }), null);
    assert.equal(w.changed("a"), false);
  });

  test("an op is counted once, however long it waits in the queue", () => {
    const w = createThumbWatch();
    const pending = [{ n: 4, op: paint("a"), at: 0 }];
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending });
    const mark = w.begin("a")!;
    w.end("a", mark, true);
    // Still queued on the next state: not a new change.
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending });
    assert.equal(w.changed("a"), false);
  });

  test("a drawing clears the mark only for changes made before it began, and one scene draws once at a time", () => {
    const w = createThumbWatch();
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending: [{ n: 1, op: paint("a"), at: 0 }] });
    const mark = w.begin("a");
    assert.notEqual(mark, null);
    assert.equal(w.begin("a"), null);
    // An undo lands while it draws.
    w.observe({ you: dm, sceneId: "a", view: view("a"), pending: [{ n: 2, op: { t: "undo" }, at: 0 }] });
    w.end("a", mark!, true);
    assert.ok(w.changed("a"));
    // A failed drawing keeps the mark for next time.
    const again = w.begin("a")!;
    w.end("a", again, false);
    assert.ok(w.changed("a"));
    w.end("a", w.begin("a")!, true);
    assert.equal(w.changed("a"), false);
  });
});

describe("a thumbnail update", () => {
  /** A DM device that changed scene a, with a server whose answer each test gives by hand. */
  function setup() {
    const thumbs = { watch: createThumbWatch(), inFlight: new Map<string, Promise<void>>() };
    let current = view("a");
    const answers: ((answer: OpAnswer) => void)[] = [];
    const sent: ClientOp[] = [];
    const deps: ThumbDeps = {
      store: { getState: () => ({ roomId: "ROOM1", view: current }) } as unknown as RoomViewStore,
      actions: {
        dispatch: (op, opts) => {
          sent.push(op);
          if (opts?.onAnswer) answers.push(opts.onAnswer);
          return sent.length;
        },
      },
      assets: { url: () => "" },
      picture: () => Promise.resolve("thumb-1"),
    };
    thumbs.watch.observe({ you: dm, sceneId: "a", view: current, pending: [{ n: 1, op: paint("a"), at: 0 }] });
    const run = () => {
      const result = { settled: false };
      const work = makeThumbnail(thumbs, deps, "a", current);
      work.then(
        () => (result.settled = true),
        () => (result.settled = true),
      );
      return { work, result };
    };
    return { thumbs, answers, sent, run, setView: (v: RoomState) => (current = v) };
  }

  /** Lets the drawing reach the point where it waits for the server. */
  const reachServer = () => new Promise((resolve) => setImmediate(resolve));

  test("is done only once the server takes it, and a refusal keeps the scene marked so the next leave tries again", async () => {
    const t = setup();
    const refused = t.run();
    await reachServer();
    assert.deepEqual(t.sent, [{ t: "scene.update", sceneId: "a", patch: { thumb: "thumb-1" } }]);
    assert.equal(refused.result.settled, false, "settled before the server answered");
    assert.ok(t.thumbs.watch.changed("a"));
    t.answers[0]!("refused");
    await assert.rejects(refused.work);
    assert.ok(t.thumbs.watch.changed("a"), "a refusal cleared the mark");

    const taken = t.run();
    await reachServer();
    assert.equal(taken.result.settled, false);
    t.answers[1]!("taken");
    await taken.work;
    assert.equal(t.thumbs.watch.changed("a"), false);
  });

  test("an answer lost with the connection counts only when the snapshot after it shows the new picture", async () => {
    const t = setup();
    const lost = t.run();
    await reachServer();
    t.answers[0]!("unknown");
    await assert.rejects(lost.work);
    assert.ok(t.thumbs.watch.changed("a"));

    const shown = t.run();
    await reachServer();
    t.setView({ scenes: { a: { id: "a", thumb: "thumb-1" } } } as unknown as RoomState);
    t.answers[1]!("unknown");
    await shown.work;
    assert.equal(t.thumbs.watch.changed("a"), false);
  });
});
