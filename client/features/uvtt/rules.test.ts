import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, room } from "#shared/testutil.ts";
import { LocalServer } from "../../dev/localServer.ts";
import { createRoomStore } from "../../state/store.ts";
import { FakeClock, FakeOutbox } from "../../state/testing.ts";
import { SCENE_LOAD_IDLE } from "../../state/sceneLoad.ts";
import type { RoomView } from "../../state/types.ts";
import { addPhase, NOT_SAME_SHAPE, TOO_SMALL } from "../phases/rules.ts";
import { importOps, importScene, placeMap } from "./batch.ts";
import { convertUvtt, type ImportPlan } from "./convert.ts";
import {
  addAnswer,
  earlyShapeProblem,
  entryShown,
  importOutcome,
  movedOn,
  mustCount,
  NO_ANSWERS,
  outcomeText,
  PARTIAL_IMPORT,
  sceneShown,
  sentContents,
  storedContents,
  type Answers,
} from "./rules.ts";
import { readUvtt } from "./schema.ts";
import { uvttFile } from "./synthetic.ts";

function scene(map: Partial<NonNullable<Scene["map"]>> = {}): Scene {
  return {
    id: "s1",
    rev: 1,
    name: "Crypt",
    order: 0,
    bounds: { w: 41, h: 31 },
    map: { assetId: "day", widthPx: 8192, heightPx: 6144, cellPx: 200, originPx: { x: 0, y: 0 }, ...map },
    grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
    background: "#000000",
    fogEnabled: true,
    wallsVersion: 0,
  };
}

describe("a phase's shape, before the upload", () => {
  test("an image that uploads as it is gets the reducer's 1 px rule", () => {
    // Within 1 percent of the shape, 2 px off: the old test let it upload for addPhase to refuse.
    const off = { width: 8192, height: 6146, resize: false };
    assert.equal(earlyShapeProblem(scene(), off), NOT_SAME_SHAPE);
    assert.deepEqual(addPhase(scene(), { assetId: "a", widthPx: 8192, heightPx: 6146, name: "Night" }, () => "id"), { problem: NOT_SAME_SHAPE });
    assert.equal(earlyShapeProblem(scene(), { width: 8192, height: 6145, resize: false }), null);
    assert.equal(earlyShapeProblem(scene(), { width: 4096, height: 3072, resize: false }), null);
  });

  test("an image that uploads as it is is checked against the grid's bounds too", () => {
    // 200 px cells on 8,192 px become 0.49 px on 20 px: the reducer refuses it, so the upload would be wasted.
    assert.equal(earlyShapeProblem(scene(), { width: 20, height: 15, resize: false }), TOO_SMALL);
  });

  test("an image the worker draws down keeps the looser test until the upload says its size", () => {
    assert.equal(earlyShapeProblem(scene(), { width: 12_000, height: 9003, resize: true }), null);
    assert.equal(earlyShapeProblem(scene(), { width: 12_000, height: 9200, resize: true }), NOT_SAME_SHAPE);
  });

  test("a scene with no map has no shape to match", () => {
    const blank = { ...scene(), map: undefined };
    assert.equal(earlyShapeProblem(blank, { width: 100, height: 100, resize: false }), "Add a map image first.");
  });
});

const p = (x: number, y: number) => ({ x, y });
const IMPORTED = "imported-scene";

function planOf(): ImportPlan {
  const read = readUvtt(
    uvttFile({
      size: p(10, 8),
      walls: [
        [p(0, 0), p(10, 0)],
        [p(1.5, 2), p(4.25, 6)],
      ],
      portals: [{ a: p(3, 8), b: p(4, 8) }],
      lights: [{ at: p(5, 5), range: 4 }],
    }),
  );
  assert.ok(read.ok);
  const converted = convertUvtt(read.map, { objects: true, portals: "window", feetPerCell: 5 });
  assert.ok(converted.ok);
  return converted.plan;
}

/**
 * The import's ops through the real store and the dev server, every answer
 * then lost with the socket, as a reconnect loses them. `refuse` makes the
 * server refuse the lights op first.
 */
function importAndReconnect(refuse: boolean) {
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(room()), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1" });
  store.setOutbox(outbox);
  store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "s1" }));
  const plan = planOf();
  const map = placeMap(plan, { assetId: "map", width: 700, height: 560, fileImageWidth: 700 });
  assert.ok(map);
  let lightId = 0;
  const ops: ClientOp[] = importOps(importScene(plan, map, { id: IMPORTED, name: "Crypt" }), plan, () => `light-${lightId++}`);
  const last = ops.at(-1);
  assert.equal(last?.t, "build.lights");
  if (refuse && last?.t === "build.lights") ops[ops.length - 1] = { ...last, put: last.put?.map((l) => ({ ...l, x: 40 })) };
  let answers: Answers = NO_ANSWERS;
  for (const op of ops) store.dispatch(op, { group: "g1", onAnswer: (a) => (answers = addAnswer(answers, a)) });
  const replies = server.batch(outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : [])));
  outbox.sent = [];
  const rejects = replies.flatMap((m) => (m.t === "ev" ? (m.rejects ?? []) : []));
  assert.equal(rejects.length, refuse ? 1 : 0, "the server refused only what the test meant it to");
  store.suspend();
  store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: "s1" }));
  const open = () => store.applySnapshot(server.hello({ resumeFrom: store.prepareHello().resumeFrom, sceneId: IMPORTED }));
  return { store, plan, ops, answers: () => answers, open };
}

describe("how an import ended", () => {
  test("every op taken is complete, with nothing to count", () => {
    const answers = { ...NO_ANSWERS, taken: 4 };
    assert.equal(mustCount(answers, true), false);
    assert.deepEqual(importOutcome(answers, { exists: true, contents: null }, { edges: 3, walls: 2, lights: 1 }), { k: "complete", checked: false });
  });

  test("answers lost in a reconnect are no success: a refusal among them shows as a scene short of what was sent", () => {
    const s = importAndReconnect(true);
    const answers = s.answers();
    assert.deepEqual(answers, { taken: 0, refused: 0, unknown: s.ops.length }, "the refusal's answer was lost with the socket");
    const exists = s.store.store.getState().view?.scenes[IMPORTED] !== undefined;
    assert.equal(mustCount(answers, exists), true);
    const sent = sentContents(s.plan);
    assert.ok(sent.edges > 0 && sent.walls > 0 && sent.lights === 1);
    // On another scene the view holds none of the new scene's contents, so it must open to be counted.
    assert.deepEqual(storedContents(s.store.store.getState().view!, IMPORTED), { edges: 0, walls: 0, lights: 0 });
    s.open();
    const contents = storedContents(s.store.store.getState().view!, IMPORTED);
    assert.deepEqual(contents, { ...sent, lights: 0 });
    const outcome = importOutcome(answers, { exists, contents }, sent);
    assert.deepEqual(outcome, { k: "unconfirmed" });
    assert.equal(
      outcomeText(outcome, "Crypt", true).text,
      "The connection dropped during the import, and Crypt could not be confirmed complete. It may be missing walls, doors or lights. Undo setup in Setup history takes the whole import back.",
    );
  });

  test("answers lost in a reconnect, and the scene holding everything sent, is complete and says so", () => {
    const s = importAndReconnect(false);
    s.open();
    const contents = storedContents(s.store.store.getState().view!, IMPORTED);
    const outcome = importOutcome(s.answers(), { exists: true, contents }, sentContents(s.plan));
    assert.deepEqual(outcome, { k: "complete", checked: true });
    const said = outcomeText(outcome, "Crypt", true);
    assert.equal(said.tone, "info");
    assert.match(said.text, /Crypt is complete: every wall, door and light is in\. Undo setup in Setup history takes the whole import back\.$/);
  });

  test("contents that could not be counted are unconfirmed, never complete", () => {
    const answers: Answers = { taken: 3, refused: 0, unknown: 1 };
    assert.deepEqual(importOutcome(answers, { exists: true, contents: null }, { edges: 1, walls: 1, lights: 0 }), { k: "unconfirmed" });
    assert.match(outcomeText({ k: "unconfirmed" }, "Crypt", false).text, /Open it from the Scenes panel\. Undo setup in Setup history takes the whole import back\.$/);
  });

  test("a scene that is not there was not made, refused or lost", () => {
    const sent = { edges: 1, walls: 0, lights: 0 };
    assert.deepEqual(importOutcome({ taken: 0, refused: 2, unknown: 0 }, { exists: false, contents: null }, sent), { k: "none", lost: false });
    assert.deepEqual(importOutcome({ taken: 0, refused: 1, unknown: 1 }, { exists: false, contents: null }, sent), { k: "none", lost: true });
    assert.equal(outcomeText({ k: "none", lost: false }, "Crypt", false).text, "The server refused the import, so no scene was made.");
    assert.equal(outcomeText({ k: "none", lost: true }, "Crypt", false).text, "The connection dropped during the import, and no scene was made. Try again.");
  });

  test("a refusal with the scene there is partial, lost answers or not", () => {
    const sent = { edges: 1, walls: 0, lights: 0 };
    assert.equal(mustCount({ taken: 2, refused: 1, unknown: 1 }, true), false);
    assert.deepEqual(importOutcome({ taken: 2, refused: 1, unknown: 1 }, { exists: true, contents: null }, sent), { k: "partial" });
    assert.equal(outcomeText({ k: "partial" }, "Crypt", false).text, PARTIAL_IMPORT);
    assert.match(PARTIAL_IMPORT, /Undo setup in Setup history/);
  });

  test("a hidden import finished on another scene says where to find it", () => {
    assert.equal(outcomeText({ k: "complete", checked: false }, "Crypt", true).text, "Crypt is imported, with every wall, door and light.");
    assert.equal(outcomeText({ k: "complete", checked: false }, "Crypt", false).text, "Crypt is imported, with every wall, door and light. Open it from the Scenes panel.");
  });
});

describe("after Hide", () => {
  const at = (sceneId: string | null, requested: string | null = null) => ({ sceneId, sceneLoad: { ...SCENE_LOAD_IDLE, requested } });

  test("the DM has moved on once another scene is shown or asked for", () => {
    assert.equal(movedOn("s1", at("s1"), "new"), false);
    assert.equal(movedOn("s1", at("s1", "s2"), "new"), true);
    assert.equal(movedOn("s1", at("s2"), "new"), true);
    // Opening the new scene themselves is no reason to keep it closed.
    assert.equal(movedOn("s1", at("s1", "new"), "new"), false);
    assert.equal(movedOn("s1", at("new"), "new"), false);
  });

  function fakeStore(initial: Partial<RoomView>) {
    let state = { sceneId: "s1", sceneLoad: SCENE_LOAD_IDLE, ended: null, ...initial } as RoomView;
    const listeners = new Set<(s: RoomView, prev: RoomView) => void>();
    return {
      getState: () => state,
      subscribe(fn: (s: RoomView, prev: RoomView) => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      set(patch: Partial<RoomView>) {
        const prev = state;
        state = { ...state, ...patch };
        for (const fn of listeners) fn(state, prev);
      },
      listeners,
    };
  }

  test("the new scene's contents are waited for until it shows", async () => {
    const store = fakeStore({ sceneLoad: { requested: "new", slow: false } });
    const shown = sceneShown(store, "new", 5000);
    store.set({ sceneLoad: { requested: null, slow: false } });
    store.set({ sceneLoad: { requested: "new", slow: true } });
    store.set({ sceneId: "new", sceneLoad: SCENE_LOAD_IDLE });
    assert.equal(await shown, true);
    assert.equal(store.listeners.size, 0);
  });

  test("the wait ends unshown when the DM asks for another scene, or the time runs out", async () => {
    const other = fakeStore({ sceneLoad: { requested: "new", slow: false } });
    const elsewhere = sceneShown(other, "new", 5000);
    other.set({ sceneLoad: { requested: "s2", slow: false } });
    assert.equal(await elsewhere, false);
    assert.equal(await sceneShown(fakeStore({ sceneLoad: { requested: "new", slow: false } }), "new", 5), false);
  });
});

describe("the import's entry at the scene limit", () => {
  test("the file picker goes away once the room is full, and an import already open keeps its dialog", () => {
    assert.deepEqual(entryShown(false, false), { picker: true, dialog: false });
    assert.deepEqual(entryShown(false, true), { picker: true, dialog: true });
    // The import whose scene was the room's last one is still sending its walls.
    assert.deepEqual(entryShown(true, true), { picker: false, dialog: true });
    assert.deepEqual(entryShown(true, false), { picker: false, dialog: false });
  });
});
