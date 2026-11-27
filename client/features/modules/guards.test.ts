import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DM, P1 } from "#shared/testutil.ts";

/*
 * The guard at each kind of entry point (docs/design/design-v1-features.md 8
 * and 13): the room store refuses a hidden part's tool and panel but a
 * borrow and a shared link, the keys of a hidden part do nothing and leave
 * the sheet, the search leaves its entries out (Floors' only on a one-floor
 * scene), the top bar leaves its parts out, Add a wing is refused wherever
 * it is picked, and ending a hidden part's work puts the tool back to
 * Select, the builder back on its first mode, an Areas group save in Dice
 * and an open panel away.
 */

const { createRoomStore } = await import("../../state/store.ts");
const { RoomScope } = await import("../../state/scope.ts");
const { INITIAL_LOCAL } = await import("../../state/types.ts");
const { shortcutFor, sheetSections, shortcutsFor, rowsLeftOut, SHORTCUTS } = await import("../../state/shortcuts.ts");
const { activeTool, toolsFor } = await import("../tools.ts");
const { panelsFor, panelOffered, panelById } = await import("../panels.ts");
const { shownBar } = await import("../../pages/topBarFit.ts");
const { builderSlot, pickBuildMode } = await import("../builder/store.ts");
const { builderCycle } = await import("../toolChoices.ts");
const { groupSaveSlot } = await import("../dice/groupSave/store.ts");
const { endHidden } = await import("./Gate.tsx");
const { indexOf, seededRoom, towerRoom, towerView, viewOf } = await import("../search/search.testutil.ts");
const { resetAllFeatures, setModuleShown, NO_CHOICES, withChoice } = await import("./store.ts");

type LocalUi = import("../../state/types.ts").LocalUi;
type RoomView = import("../../state/types.ts").RoomView;

afterEach(() => resetAllFeatures());

function dmRoom() {
  return createRoomStore({ roomId: "R", you: { memberId: "dm1", role: "dm" } });
}

describe("the room store's guard", () => {
  test("a hidden part's tool is refused, a borrow is not, and the next change ends the borrow", () => {
    const room = dmRoom();
    const local = () => room.store.getState().local;
    setModuleShown("areas", "dm", false);
    room.ui.setTool("area");
    assert.equal(local().tool, "select");
    room.ui.setTool("area", { borrow: true });
    assert.equal(local().tool, "area");
    assert.equal(local().toolBorrowed, true);
    room.ui.setTool("trap");
    assert.equal(local().tool, "trap");
    assert.equal(local().toolBorrowed, undefined);
    setModuleShown("areas", "dm", true);
    room.ui.setTool("area");
    assert.equal(local().tool, "area");
    room.dispose();
  });

  test("a hidden part's panel is refused, but a shared link opens it once", () => {
    const room = dmRoom();
    const local = () => room.store.getState().local;
    setModuleShown("journal", "dm", false);
    room.ui.openPanel("journal");
    assert.equal(local().panel, null);
    room.ui.openPanel("journal", undefined, { link: true });
    assert.equal(local().panel, "journal");
    room.ui.openPanel("dice");
    assert.equal(local().panel, "dice", "a core panel always opens");
    room.dispose();
  });

  test("the canvas's tool: Select for a hidden part's, the tool itself when borrowed", () => {
    const off = withChoice(NO_CHOICES, "player", "ruler", false);
    assert.equal(activeTool("ruler", "player", off).id, "select");
    assert.equal(activeTool("ruler", "player", off, true).id, "ruler");
    assert.equal(activeTool("ruler", "dm", off).id, "ruler");
    assert.deepEqual(
      toolsFor("player", undefined, off).map((t) => t.id),
      toolsFor("player").filter((t) => t.id !== "ruler").map((t) => t.id),
    );
  });
});

describe("keys and the shortcut sheet", () => {
  const press = (key: string, role: "dm" | "player") => {
    const env = { role, tools: toolsFor(role, undefined, NO_CHOICES).map((t) => ({ id: t.id })), getState: () => ({ local: INITIAL_LOCAL, view: null }) as unknown as RoomView, actions: {} as never, ui: {} as never, scope: new RoomScope() };
    return shortcutFor({ key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, target: null } as never, env, { dialogOpen: false, preview: false })?.id ?? null;
  };

  test("R pressed with Ruler hidden does nothing, and the key stays the Ruler's", () => {
    assert.equal(press("r", "player"), "tool:ruler");
    setModuleShown("ruler", "player", false);
    assert.equal(press("r", "player"), null);
    assert.equal(press("r", "dm"), "tool:ruler", "the DM's choices are the DM's");
    assert.equal(press("f", "dm"), "tool:fog");
  });

  test("a hidden part's rows and surface sections leave the sheet, and the sheet says rows are left out", () => {
    const rows = (role: "dm" | "player") => sheetSections(role, { mouse: true, android: false }).flatMap((s) => s.rows.map((r) => r.id));
    const titles = () => sheetSections("dm", { mouse: true, android: false }).map((s) => s.title);
    assert.ok(titles().includes("Music"));
    assert.equal(rowsLeftOut("dm"), false);
    setModuleShown("sound", "dm", false);
    setModuleShown("diceAnimation", "dm", false);
    setModuleShown("builder", "dm", false);
    assert.ok(!titles().includes("Music"));
    for (const id of ["mute", "diceThrowEnd", "tool:build", "linkMove", "linkResize", "wingArea", "roomEdits"]) assert.ok(!rows("dm").includes(id), id);
    assert.ok(rows("player").includes("mute"), "a player's sheet keeps its own");
    assert.ok(rowsLeftOut("dm"));
    assert.ok(!shortcutsFor("dm").some((s) => s.id === "mute"));
    assert.equal(shortcutsFor("dm").length, SHORTCUTS.filter((s) => s.roles.includes("dm")).length - 2);
  });
});

describe("panels, the top bar and the builder", () => {
  test("a hidden part's panel is not offered, but while it is open", () => {
    const off = withChoice(NO_CHOICES, "player", "journal", false);
    assert.ok(!panelsFor("player", true, { choices: off }).some((p) => p.id === "journal"));
    assert.ok(panelOffered(panelById("journal")!, "player", true, { choices: off, open: (id) => id === "journal" }));
    assert.ok(panelOffered(panelById("journal")!, "dm", true, { choices: off }));
  });

  test("the top bar leaves out a hidden part's parts before the fit", () => {
    const content = { phone: false, role: "dm" as const, search: true, nowPlaying: true, clock: true, blackout: false, fullscreen: true, phase: false, gaps: true, view: true, volume: true, floor: false, strip: "none" as const, faces: 0, timerOver: false, yourTurn: false, words: [] };
    assert.equal(shownBar(content, NO_CHOICES), content);
    const off = withChoice(withChoice(withChoice(NO_CHOICES, "dm", "sound", false), "dm", "time", false), "dm", "isometric", false);
    assert.deepEqual(shownBar(content, off), { ...content, nowPlaying: false, volume: false, clock: false, view: false });
    assert.equal(shownBar({ ...content, role: null }, off).clock, true, "before the role is known every part shows");
  });

  test("Add a wing is refused in the mode list's pick and the key's cycle while the generator hides", () => {
    const scope = new RoomScope();
    const builder = scope.get(builderSlot).store;
    setModuleShown("dungeon", "dm", false);
    pickBuildMode(scope, "wing");
    assert.equal(builder.getState().mode, "paint");
    pickBuildMode(scope, "edge");
    assert.equal(builder.getState().mode, "edge");
    const state = { you: DM, sceneId: "s1", local: INITIAL_LOCAL, view: { scenes: { s1: { id: "s1", bounds: { w: 10, h: 10 } } }, tokens: {}, members: {}, meta: { settings: {} } }, get floorView() { return this.view; } };
    const env = { role: "dm" as const, getState: () => state as unknown as RoomView, actions: {} as never, scope };
    assert.ok(!builderCycle.now(env)!.options.some((o) => o.value === "wing"));
    builderCycle.pick(env, "wing");
    assert.equal(builder.getState().mode, "edge");
    setModuleShown("dungeon", "dm", true);
    assert.ok(builderCycle.now(env)!.options.some((o) => o.value === "wing"));
  });
});

describe("the search", () => {
  const ids = (state: RoomView) => indexOf(state).items.map((i) => i.entry.id);

  test("a hidden part's entries leave the index, and the others stay", () => {
    const everything = ids(viewOf(seededRoom(), DM));
    setModuleShown("sound", "dm", false);
    setModuleShown("tableDisplay", "dm", false);
    const hidden = ids(viewOf(seededRoom(), DM));
    const gone = everything.filter((id) => !hidden.includes(id));
    assert.ok(gone.includes("panel:sound") && gone.includes("key:mute") && gone.includes("section:sound.now") && gone.includes("setting:dm.display.show-view"));
    assert.ok(gone.every((id) => /^(panel:sound|key:mute|section:sound\.|setting:sound\.|action:sound\.|section:scenes\.sound|setting:menu\.this-device\.sounds\.(volume|music|loops|effects)|playlist:|action:play:|track:|section:dm\.display|setting:dm\.display\.|action:dm\.display\.)/.test(id)), gone.join(" "));
    assert.ok(hidden.includes("setting:menu.this-device.sounds.turn"), "Turn sound stays with the alert sounds");
  });

  test("Floors' entries leave only on a scene with one floor", () => {
    assert.ok(ids(viewOf(seededRoom(), DM)).includes("action:scenes.floors.add-above"));
    setModuleShown("floors", "dm", false);
    assert.ok(!ids(viewOf(seededRoom(), DM)).includes("action:scenes.floors.add-above"));
    assert.ok(ids(towerView(towerRoom(), DM, "ground", ["ground", "upper", "attic"])).includes("action:scenes.floors.add-above"));
  });

  test("a player's index follows the player's choices", () => {
    assert.ok(ids(viewOf(seededRoom(), P1)).some((id) => id.startsWith("field:") && id.endsWith(":companions")));
    setModuleShown("companions", "player", false);
    assert.ok(!ids(viewOf(seededRoom(), P1)).some((id) => id.startsWith("field:") && id.endsWith(":companions")));
  });
});

describe("ending a hidden part's work", () => {
  function room(local: Partial<LocalUi>) {
    const r = dmRoom();
    r.store.setState({ local: { ...INITIAL_LOCAL, ...local } });
    const scope = new RoomScope();
    return { r, scope, local: () => r.store.getState().local, end: (choices: import("./store.ts").FeatureChoices, wide: boolean) => endHidden({ local: () => r.store.getState().local, ui: r.ui, scope }, "dm", choices, wide) };
  }

  test("an active tool goes back to Select, a borrowed one stays", () => {
    const off = withChoice(NO_CHOICES, "dm", "areas", false);
    const a = room({ tool: "area" });
    a.end(off, true);
    assert.equal(a.local().tool, "select");
    const b = room({ tool: "area", toolBorrowed: true });
    b.end(off, true);
    assert.equal(b.local().tool, "area");
  });

  test("the builder leaves Add a wing for its first mode, its wing picks dropped", () => {
    const a = room({ tool: "build" });
    const builder = a.scope.get(builderSlot).store;
    builder.setState({ mode: "wing", wingOpen: true });
    a.end(withChoice(NO_CHOICES, "dm", "dungeon", false), true);
    assert.equal(builder.getState().mode, "paint");
    assert.equal(builder.getState().wingOpen, false);
    assert.equal(a.local().tool, "build", "the builder stays");
  });

  test("an Areas group save moves to Dice where Areas stood, its page kept", () => {
    const off = withChoice(NO_CHOICES, "dm", "areas", false);
    for (const wide of [true, false]) {
      const a = room(wide ? { tab: "areas", panel: "areas" } : { panel: "areas" });
      const save = a.scope.get(groupSaveSlot);
      const page = { id: "g1" } as never;
      save.setState({ page, shownIn: "areas" });
      a.end(off, wide);
      assert.equal(save.getState().shownIn, "dice");
      assert.equal(save.getState().page, page);
      assert.equal(wide ? a.local().tab : a.local().panel, "dice", wide ? "the top pane" : "the sheet");
    }
  });

  test("an open panel of a hidden part closes: a tab to the default tab, the bottom pane away, a phone's sheet for good", () => {
    const off = withChoice(withChoice(NO_CHOICES, "dm", "journal", false), "dm", "outliner", false);
    const a = room({ tab: "journal", below: "outliner", splitFits: true, panel: "journal" });
    a.end(off, true);
    assert.equal(a.local().tab, "tracker");
    assert.equal(a.local().below, null);
    const b = room({ panel: "journal" });
    b.end(off, false);
    assert.equal(b.local().panel, null);
    const c = room({ panel: "log", tab: "log" });
    c.end(off, true);
    assert.equal(c.local().tab, "log", "a core panel stays");
  });
});
