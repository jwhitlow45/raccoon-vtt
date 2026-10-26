import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EphEvent } from "#shared/protocol.ts";
import { RoomScope } from "../state/scope.ts";
import type { RoomActions, RoomView } from "../state/types.ts";
import { areaSlot } from "./areas/store.ts";
import { newDraft } from "./areas/placement.ts";
import { builderSlot, labelPaneSlot } from "./builder/store.ts";
import { drawSlot } from "./drawings/store.ts";
import { fogSlot } from "./fog/store.ts";
import { rulerSlot } from "./measure/rulerStore.ts";
import { placementSlot } from "./tokens/placement.ts";
import { trapSlot } from "./traps/store.ts";
import {
  areaCycle,
  builderCycle,
  cycleStep,
  drawCycle,
  fogCycle,
  LABEL_HELD,
  placeCycle,
  ROOM_HELD,
  rulerCycle,
  SHAPE_HELD,
  SPELL_HELD,
  TEXT_HELD,
  trapCycle,
  type ChoiceOption,
  type CycleEnv,
} from "./toolChoices.ts";

const ABC: ChoiceOption[] = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

describe("cycleStep", () => {
  test("one option forward, or back with Shift, wrapping at both ends", () => {
    assert.equal(cycleStep(ABC, "a", false), "b");
    assert.equal(cycleStep(ABC, "b", false), "c");
    assert.equal(cycleStep(ABC, "c", false), "a", "wraps past the end");
    assert.equal(cycleStep(ABC, "c", true), "b");
    assert.equal(cycleStep(ABC, "a", true), "c", "wraps past the start");
  });

  test("a value missing from the list goes to the first option, or back to the last", () => {
    assert.equal(cycleStep(ABC, "z", false), "a");
    assert.equal(cycleStep(ABC, "z", true), "c");
  });

  test("an option the state disables is skipped, and with none usable nothing moves", () => {
    const list = ABC.map((o) => (o.value === "b" ? { ...o, disabled: true } : o));
    assert.equal(cycleStep(list, "a", false), "c");
    assert.equal(cycleStep(list, "c", true), "a");
    assert.equal(cycleStep(list, "z", false), "a");
    const none = ABC.map((o) => ({ ...o, disabled: true }));
    assert.equal(cycleStep(none, "a", false), null);
    assert.equal(cycleStep([], "a", true), null);
  });
});

describe("each tool's main choice", () => {
  type Sent = { e: EphEvent; localOnly?: boolean };

  function room(input: { role?: "dm" | "player"; fog?: boolean; scene?: boolean; playersDraw?: "none" | "all"; drawings?: Record<string, unknown>; templates?: Record<string, unknown> } = {}) {
    const role = input.role ?? "dm";
    const sent: Sent[] = [];
    const scope = new RoomScope();
    const scene = { id: "s1", fogEnabled: input.fog ?? true, bounds: { w: 30, h: 20 } };
    const state = {
      you: { memberId: role === "dm" ? "dm1" : "p1", role },
      sceneId: "s1",
      local: { tool: "", selectedIds: [], selectedId: null },
      view:
        input.scene === false
          ? { scenes: {}, templates: {}, tokens: {}, drawings: {}, members: {}, meta: { settings: {} } }
          : {
              scenes: { s1: scene },
              templates: input.templates ?? {},
              tokens: {},
              drawings: input.drawings ?? {},
              members: {},
              meta: { settings: { feetPerCell: 5, ...(input.playersDraw ? { playersDraw: input.playersDraw } : {}) } },
            },
    };
    let ids = 0;
    const env: CycleEnv = {
      role,
      getState: () => state as unknown as RoomView,
      actions: {
        sendEph: (e: EphEvent, opts?: { localOnly?: boolean }) => void sent.push({ e, ...(opts?.localOnly !== undefined ? { localOnly: opts.localOnly } : {}) }),
        newId: () => `id${++ids}`,
        dispatch: () => 1,
      } as unknown as RoomActions,
      scope,
    };
    return { env, scope, sent, state };
  }

  test("the Ruler always has Straight or Walking, starts on this device's last, and stores a pick and measures again", () => {
    const { env, scope, sent } = room();
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    try {
      assert.deepEqual(rulerCycle.now(env), { options: rulerCycle.now(env)!.options, value: "straight" });
      assert.deepEqual(rulerCycle.now(env)!.options.map((o) => o.label), ["Straight", "Walking"]);
      const tool = scope.get(rulerSlot);
      tool.activeCtx = { ...env, ui: {}, scene: {}, camera: () => ({ x: 0, y: 0, scale: 1 }) } as never;
      tool.store.setState({ ruler: { id: "r1", stops: [{ x: 1, y: 1 }, { x: 4, y: 1 }], shared: false } as never, share: true });
      rulerCycle.pick(env, "walking");
      assert.equal(tool.store.getState().walk, true);
      assert.equal(stored.get("rvtt.ruler.measure"), "walking", "kept on this device");
      assert.equal(sent.length, 1, "the ruler on the map measures again");
      assert.deepEqual([sent[0]!.e.k, (sent[0]!.e as { walk?: boolean }).walk, sent[0]!.localOnly], ["ruler", true, false], "a shared ruler goes to players again");
      // A reload: a new page's ruler starts on what this device stored.
      assert.equal(rulerCycle.now(room().env)!.value, "walking");
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("Area idle: the last shape, and a pick sets the next area's", () => {
    const { env, scope } = room();
    const choice = areaCycle.now(env)!;
    assert.deepEqual(choice.options.map((o) => o.label), ["Cone", "Sphere", "Cylinder", "Cube", "Line", "Emanation"]);
    assert.equal(choice.value, "cone");
    assert.equal(choice.held, undefined);
    areaCycle.pick(env, "sphere");
    assert.equal(scope.get(areaSlot).store.getState().shape, "sphere");
    assert.equal(scope.get(areaSlot).store.getState().draft, null);
  });

  test("Area with a placed area picked has no choice, and one on another scene leaves it idle", () => {
    const templates = { t1: { id: "t1", sceneId: "s1", shape: "cube" }, t2: { id: "t2", sceneId: "s2", shape: "cube" } };
    const { env, scope } = room({ templates });
    scope.get(areaSlot).store.setState({ selectedId: "t1" });
    assert.equal(areaCycle.now(env), null);
    scope.get(areaSlot).store.setState({ selectedId: "t2" });
    assert.equal(areaCycle.now(env)?.value, "cone");
  });

  test("Area placing a plain area: the draft takes the next shape's own size at the same point, keeps its sharing and sends the new shape", () => {
    const { env, scope, sent } = room();
    const area = scope.get(areaSlot).store;
    const draft = { ...newDraft("d1", "cone", "#fff"), point: { x: 5, y: 6, z: 0 }, yaw: 90 };
    area.setState({ draft, shared: true });
    assert.equal(areaCycle.now(env)?.value, "cone");
    areaCycle.pick(env, "sphere");
    const next = area.getState().draft!;
    assert.equal(next.shape, "sphere");
    assert.equal(next.size, 20, "a sphere's own size");
    assert.deepEqual(next.point, { x: 5, y: 6, z: 0 }, "at the same point");
    assert.equal(next.id, "d1");
    assert.equal(area.getState().shared, true, "still shared");
    assert.equal(area.getState().shape, "sphere", "the next area starts as a sphere too");
    assert.equal(sent.at(-1)?.e.k, "aoe");
    assert.equal((sent.at(-1)?.e as { shape?: string }).shape, "sphere", "players see the new shape");
  });

  test("Area holds a draft that carries a spell, from the search or a copy, and a trap's area moves and stays the trap's", () => {
    const { env, scope } = room();
    const area = scope.get(areaSlot).store;
    area.setState({ draft: { ...newDraft("d1", "sphere", "#fff"), spell: "Fireball", note: "20 ft radius" } });
    assert.deepEqual(areaCycle.now(env), { options: areaCycle.now(env)!.options, value: "sphere", held: SPELL_HELD });
    area.setState({ draft: { ...newDraft("d2", "cone", "#fff"), point: { x: 1, y: 1, z: 0 } }, forTrap: "trap1" });
    assert.equal(areaCycle.now(env)?.held, undefined);
    areaCycle.pick(env, "sphere");
    assert.equal(area.getState().draft?.shape, "sphere");
    assert.equal(area.getState().forTrap, "trap1", "Save still puts it into the trap");
  });

  test("Area draws nothing before the room's view, and so has no choice", () => {
    const { env, state } = room();
    (state as { view: unknown }).view = null;
    assert.equal(areaCycle.now(env), null);
  });

  test("Area draws nothing with no scene shown or before the room says who you are, and so has no choice (TCB-4)", () => {
    const noScene = room();
    (noScene.state as { sceneId: unknown }).sceneId = null;
    assert.equal(areaCycle.now(noScene.env), null, "no scene");
    const noYou = room();
    (noYou.state as { you: unknown }).you = null;
    assert.equal(areaCycle.now(noYou.env), null, "no you");
  });

  test("Draw: its drawing tool on the full row, held for a shape with corners and for text waiting", () => {
    const { env, scope } = room();
    const draw = scope.get(drawSlot).store;
    const choice = drawCycle.now(env)!;
    assert.deepEqual(choice.options.map((o) => o.label), ["Pen", "Line", "Arrow", "Box", "Circle", "Shape", "Text", "Eraser"]);
    assert.equal(choice.value, "free");
    assert.equal(choice.held, undefined);
    draw.setState({ mode: "polygon", draft: { kind: "polygon", points: [1, 1, 2, 2] } });
    assert.equal(drawCycle.now(env)?.held, SHAPE_HELD);
    draw.setState({ mode: "polygon", draft: { kind: "polygon", points: [] } });
    assert.equal(drawCycle.now(env)?.held, undefined, "no corners yet");
    draw.setState({ mode: "text", draft: null, textAt: { x: 3, y: 3 }, text: "Here" });
    assert.equal(drawCycle.now(env)?.held, TEXT_HELD);
    draw.setState({ textAt: null, draft: { kind: "free", points: [1, 1, 2, 2] } });
    drawCycle.pick(env, "line");
    assert.deepEqual([draw.getState().mode, draw.getState().draft, draw.getState().textAt], ["line", null, null], "a pick ends any draft");
  });

  test("Draw for a player who may only erase has no choice", () => {
    const drawings = { d1: { id: "d1", sceneId: "s1", kind: "free", ownerId: "p1" } };
    assert.equal(drawCycle.now(room({ role: "player", playersDraw: "none", drawings }).env), null);
    assert.equal(drawCycle.now(room({ role: "player", playersDraw: "all" }).env)?.value, "free");
  });

  test("Fog: Clear or add fog while fog is on, and a polygon's corners stay through a pick", () => {
    assert.equal(fogCycle.now(room({ fog: false }).env), null);
    const { env, scope } = room();
    const fog = scope.get(fogSlot).store;
    assert.deepEqual(fogCycle.now(env)!.options.map((o) => o.label), ["Clear fog", "Add fog"]);
    assert.equal(fogCycle.now(env)!.value, "reveal");
    fog.setState({ shape: "poly", poly: [{ x: 1, y: 1 }, { x: 3, y: 1 }] });
    fogCycle.pick(env, "hide");
    assert.equal(fog.getState().mode, "hide");
    assert.equal(fog.getState().poly.length, 2, "corners kept");
    assert.equal(fogCycle.now(env)?.held, undefined, "fog never holds");
  });

  test("the builder: its eleven modes once the scene is loaded, by the names a press says (FU32-SR-NAMES), held for a shape room's corners and an open label pane, and a pick clears the gesture", () => {
    assert.equal(builderCycle.now(room({ scene: false }).env), null);
    const { env, scope } = room();
    const builder = scope.get(builderSlot).store;
    const choice = builderCycle.now(env)!;
    assert.deepEqual(
      choice.options.map((o) => o.label),
      ["Brush", "Rectangle room", "Shape room", "Erase", "Erase area", "Walls and doors", "Heights and stairs", "Difficult ground", "Label", "Lights", "Stamp"],
    );
    assert.equal(choice.value, "paint");
    builder.setState({ mode: "poly", poly: [{ x: 1, y: 1 }, { x: 2, y: 1 }] });
    assert.equal(builderCycle.now(env)?.held, ROOM_HELD);
    builder.setState({ mode: "label", poly: [] });
    scope.get(labelPaneSlot).setState({ labelId: "l1" });
    assert.equal(builderCycle.now(env)?.held, LABEL_HELD);
    scope.get(labelPaneSlot).setState({ labelId: null });
    assert.equal(builderCycle.now(env)?.held, undefined);
    builder.setState({ mode: "rect", rect: { a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }, run: ["e1"], note: "Tap inside." });
    builderCycle.pick(env, "erase");
    const s = builder.getState();
    assert.deepEqual([s.mode, s.rect, s.run, s.note, s.poly], ["erase", null, [], null, []]);
  });

  test("Add token: the blank kind while nothing else is chosen, and goblins waiting stay", () => {
    const { env, scope } = room();
    const place = scope.get(placementSlot).store;
    assert.deepEqual(placeCycle.now(env)!.options.map((o) => o.label), ["Blank monster", "Blank NPC", "Blank object", "Blank player character"]);
    assert.equal(placeCycle.now(env)!.value, "monster");
    placeCycle.pick(env, "npc");
    assert.deepEqual(place.getState().pending, { kind: "blank", tokenKind: "npc" });
    place.setState({ pending: { kind: "monster", monster: { name: "Goblin" } as never, count: 3 } as never });
    assert.equal(placeCycle.now(env), null);
  });

  test("the Trap: the zone on its plain row, none while a pick waits or a pane is open, and Start from stays", () => {
    const { env, scope } = room();
    const trap = scope.get(trapSlot).store;
    assert.deepEqual(trapCycle.now(env)!.options.map((o) => o.label), ["Squares", "Trip wire", "Door"]);
    trap.setState({ start: "alarm" });
    trapCycle.pick(env, "wire");
    assert.deepEqual([trap.getState().kind, trap.getState().start], ["wire", "alarm"]);
    trap.setState({ paneId: "t1" });
    assert.equal(trapCycle.now(env), null);
    trap.setState({ paneId: null, picking: { trapId: "t1", what: "squares" } });
    assert.equal(trapCycle.now(env), null);
  });

  test("a pick of a value the list lacks changes nothing", () => {
    const { env, scope } = room();
    drawCycle.pick(env, "ruler");
    assert.equal(scope.get(drawSlot).store.getState().mode, "free");
    builderCycle.pick(env, "nope");
    assert.equal(scope.get(builderSlot).store.getState().mode, "paint");
  });
});
