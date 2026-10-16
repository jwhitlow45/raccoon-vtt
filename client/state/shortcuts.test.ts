import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import { RoomScope } from "./scope.ts";
import {
  BEHAVIORS,
  deletedText,
  isTextField,
  sheetSections,
  SHORTCUTS,
  shortcutFor,
  shortcutSheetSlot,
  shortcutsFor,
  sidePanelKeysSlot,
  stageKeysSlot,
  SURFACES,
  undoShortcut,
  whoText,
  ZOOM_STEP,
  MOUSE_SECTION,
  type Behavior,
  type KeyPress,
  type SheetDevice,
  type ShortcutEnv,
} from "./shortcuts.ts";
import type { RoomUi } from "./store.ts";
import type { RoomActions, RoomView } from "./types.ts";

const body = { tagName: "BODY" };

function press(overrides: Partial<KeyPress>): KeyPress {
  return { key: "z", code: "KeyZ", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, target: body, ...overrides };
}

describe("undo shortcuts", () => {
  test("Ctrl+Z or Cmd+Z undoes, and with Shift redoes", () => {
    assert.equal(undoShortcut(press({ ctrlKey: true })), "undo");
    assert.equal(undoShortcut(press({ metaKey: true })), "undo");
    assert.equal(undoShortcut(press({ ctrlKey: true, shiftKey: true, key: "Z" })), "redo");
    assert.equal(undoShortcut(press({ metaKey: true, shiftKey: true })), "redo");
  });

  test("anything else is not a shortcut", () => {
    assert.equal(undoShortcut(press({})), null, "a plain z is typing");
    assert.equal(undoShortcut(press({ ctrlKey: true, altKey: true })), null);
    assert.equal(undoShortcut(press({ ctrlKey: true, key: "y", code: "KeyY" })), null);
    assert.equal(undoShortcut(press({ ctrlKey: true, repeat: true })), null, "a held key undoes once");
    assert.equal(undoShortcut(press({ ctrlKey: true, defaultPrevented: true })), null);
  });

  test("the letter follows the layout, and a non-Latin layout uses the key's place", () => {
    // AZERTY: Z sits where QWERTY has W.
    assert.equal(undoShortcut(press({ ctrlKey: true, key: "z", code: "KeyW" })), "undo");
    assert.equal(undoShortcut(press({ ctrlKey: true, key: "w", code: "KeyZ" })), null);
    // Russian: the Z key types я.
    assert.equal(undoShortcut(press({ ctrlKey: true, key: "я", code: "KeyZ" })), "undo");
  });

  test("they do nothing while typing in a text field", () => {
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "search" }, { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      assert.equal(isTextField(target), true, JSON.stringify(target));
      assert.equal(undoShortcut(press({ ctrlKey: true, target })), null);
    }
    for (const target of [body, { tagName: "BUTTON" }, { tagName: "INPUT", type: "range" }, { tagName: "INPUT", type: "checkbox" }, null]) {
      assert.equal(isTextField(target), false, JSON.stringify(target));
    }
    assert.equal(undoShortcut(press({ ctrlKey: true, target: { tagName: "BUTTON" } })), "undo");
  });
});

describe("the shortcut table", () => {
  type Calls = { tool: string[]; ops: { op: ClientOp; group?: string }[]; notes: string[]; panels: string[]; undo: number; selected: (string | null)[] };

  function env(input: { role?: "dm" | "player"; selected?: string[]; playersDraw?: "none" | "all" | string[]; turn?: "mine" | "theirs" | null } = {}) {
    const role = input.role ?? "dm";
    const calls: Calls = { tool: [], ops: [], notes: [], panels: [], undo: 0, selected: [] };
    const tokens: Record<string, unknown> = {
      t1: { id: "t1", sceneId: "s1", name: "Goblin", number: 2, visibility: "all", locked: false, ownerIds: [], actor: {}, kind: "monster", elevation: 0 },
      t2: { id: "t2", sceneId: "s1", name: "Thorn", visibility: "dm", locked: true, ownerIds: ["p1"], actor: {}, kind: "pc", elevation: 5 },
    };
    const encounter = input.turn
      ? { round: 1, activeEntryId: "e1", entries: [{ id: "e1", tokenId: input.turn === "mine" ? "t2" : "t1", init: 10 }] }
      : null;
    const state = {
      you: { memberId: role === "dm" ? "dm1" : "p1", role },
      sceneId: "s1",
      pending: [],
      local: { selectedIds: input.selected ?? [], selectedId: input.selected?.at(-1) ?? null },
      view: { tokens, characters: {}, encounter, meta: { settings: input.playersDraw === undefined ? {} : { playersDraw: input.playersDraw } } },
    };
    const scope = new RoomScope();
    const e: ShortcutEnv = {
      role,
      tools: (role === "dm" ? ["select", "ruler", "area", "draw", "ping", "add-token", "fog", "build", "grid"] : ["select", "ruler", "area", "draw", "ping"]).map((id) => ({ id })),
      getState: () => state as unknown as RoomView,
      actions: {
        dispatch: (op, opts) => {
          calls.ops.push(opts?.group ? { op, group: opts.group } : { op });
          return 1;
        },
        newId: () => "g1",
        undo: () => void calls.undo++,
        redo: () => {},
      } as RoomActions,
      ui: {
        setTool: (id: string) => void calls.tool.push(id),
        notify: (text: string) => void calls.notes.push(text),
        openPanel: (id: string) => void calls.panels.push(id),
        select: (id: string | null) => void calls.selected.push(id),
      } as unknown as RoomUi,
      scope,
    };
    return { env: e, calls, scope };
  }

  const open = { dialogOpen: false, preview: false };
  const run = (e: ShortcutEnv, p: KeyPress, gates = open) => {
    const s = shortcutFor(p, e, gates);
    s?.run(e, p);
    return s?.id ?? null;
  };

  test("letters pick tools by role, where they are printed or by their place on a non-Latin layout", () => {
    const dm = env();
    assert.equal(run(dm.env, press({ key: "v", code: "KeyV" })), "tool:select");
    assert.equal(run(dm.env, press({ key: "F", code: "KeyF", shiftKey: true })), "tool:fog");
    // AZERTY: the A key sits where QWERTY has Q.
    assert.equal(run(dm.env, press({ key: "a", code: "KeyQ" })), "tool:area");
    // Russian: the key at V types м.
    assert.equal(run(dm.env, press({ key: "м", code: "KeyV" })), "tool:select");
    assert.deepEqual(dm.calls.tool, ["select", "fog", "area", "select"]);
    const player = env({ role: "player" });
    assert.equal(run(player.env, press({ key: "f", code: "KeyF" })), null, "Fog is the DM's");
    assert.equal(run(player.env, press({ key: "b", code: "KeyB" })), null);
    assert.equal(run(player.env, press({ key: "p", code: "KeyP" })), "tool:ping");
  });

  test("Draw only for a player the DM lets draw, and a tool the toolbar lacks does nothing", () => {
    assert.equal(run(env({ role: "player" }).env, press({ key: "d", code: "KeyD" })), "tool:draw");
    assert.equal(run(env({ role: "player", playersDraw: "none" }).env, press({ key: "d", code: "KeyD" })), null);
    assert.equal(run(env({ role: "player", playersDraw: ["p2"] }).env, press({ key: "d", code: "KeyD" })), null);
    assert.equal(run(env({ role: "player", playersDraw: ["p1"] }).env, press({ key: "d", code: "KeyD" })), "tool:draw");
    assert.equal(run(env({ playersDraw: "none" }).env, press({ key: "d", code: "KeyD" })), "tool:draw", "the DM always draws");
    assert.equal(run(env().env, press({ key: "m", code: "KeyM" })), null, "no Pin tool registered yet");
  });

  test("nothing fires in a field, a select box, a dialog or the preview, on a repeat, or with Ctrl, Cmd or Alt", () => {
    const { env: e, calls } = env();
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      assert.equal(run(e, press({ key: "v", code: "KeyV", target })), null, JSON.stringify(target));
    }
    assert.equal(run(e, press({ key: "v", code: "KeyV" }), { dialogOpen: true, preview: false }), null);
    assert.equal(run(e, press({ key: "v", code: "KeyV" }), { dialogOpen: false, preview: true }), null);
    assert.equal(run(e, press({ key: "z", code: "KeyZ", ctrlKey: true }), { dialogOpen: false, preview: true }), null, "Ctrl+Z inside the preview never reaches the DM's room");
    assert.equal(run(e, press({ key: "z", code: "KeyZ", ctrlKey: true }), { dialogOpen: true, preview: false }), null, "nor through the DM's page behind it");
    assert.equal(run(e, press({ key: "v", code: "KeyV", repeat: true })), null);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.equal(run(e, press({ key: "v", code: "KeyV", ...mod })), null);
    assert.equal(run(e, press({ key: "v", code: "KeyV", target: { tagName: "BUTTON" } })), "tool:select", "a focused button is no field");
    assert.equal(calls.tool.length, 1);
  });

  test("undo and redo are rows of the same table", () => {
    const { env: e, calls } = env({ role: "player" });
    assert.equal(run(e, press({ key: "z", code: "KeyZ", metaKey: true })), "undo");
    assert.equal(run(e, press({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true })), "redo");
    assert.equal(run(e, press({ key: "z", code: "KeyZ" })), null, "a plain z is no undo");
    assert.equal(calls.undo, 1);
  });

  test("symbols match by key, with Shift allowed", () => {
    const { env: e, scope } = env();
    let zoomed = 0;
    scope.get(stageKeysSlot).zoom = (f) => void (zoomed = f);
    assert.equal(run(e, press({ key: "+", code: "Equal", shiftKey: true })), "zoomIn");
    assert.equal(zoomed, ZOOM_STEP);
    assert.equal(run(e, press({ key: "-", code: "Minus" })), "zoomOut");
    assert.equal(zoomed, 1 / ZOOM_STEP);
    assert.equal(run(e, press({ key: "?", code: "Slash", shiftKey: true })), "sheet");
    assert.equal(scope.get(shortcutSheetSlot).open, true);
    // A German layout's ? is Shift and the ß key: the key decides, not its place.
    assert.equal(run(env().env, press({ key: "?", code: "Minus", shiftKey: true })), "sheet");
    assert.equal(run(e, press({ key: "/", code: "Slash" })), "outliner");
    assert.equal(run(env({ role: "player" }).env, press({ key: "/", code: "Slash" })), null, "the outliner is the DM's");
  });

  test("selection shortcuts need a selection, and the DM's need the DM", () => {
    assert.equal(run(env().env, press({ key: "h", code: "KeyH" })), null);
    const { env: e, calls } = env({ selected: ["t1", "t2"] });
    assert.equal(run(e, press({ key: "h", code: "KeyH" })), "hide");
    assert.deepEqual(calls.ops.at(-1)?.op, { t: "token.updateMany", tokenIds: ["t1", "t2"], patch: { visibility: "dm" } });
    assert.equal(run(e, press({ key: "l", code: "KeyL" })), "lock");
    assert.deepEqual(calls.ops.at(-1)?.op, { t: "token.updateMany", tokenIds: ["t1", "t2"], patch: { locked: true } });
    assert.equal(run(e, press({ key: "Delete", code: "Delete" })), "delete");
    assert.deepEqual(calls.ops.at(-1)?.op, { t: "token.deleteMany", tokenIds: ["t1", "t2"] });
    assert.deepEqual(calls.notes, ["Deleted 2 tokens. Ctrl+Z brings them back."]);
    assert.equal(deletedText(["Goblin 2"]), "Deleted Goblin 2. Ctrl+Z brings it back.");
    const player = env({ role: "player", selected: ["t2"] });
    assert.equal(run(player.env, press({ key: "Backspace", code: "Backspace" })), null);
    assert.equal(run(player.env, press({ key: "h", code: "KeyH" })), null);
  });

  test("Page Up and Page Down raise only what the viewer may, as one undo step", () => {
    const dm = env({ selected: ["t1", "t2"] });
    assert.equal(run(dm.env, press({ key: "PageUp", code: "PageUp" })), "elevation");
    assert.deepEqual(dm.calls.ops, [
      { op: { t: "token.update", tokenId: "t1", patch: { elevation: 5 } }, group: "g1" },
      { op: { t: "token.update", tokenId: "t2", patch: { elevation: 10 } }, group: "g1" },
    ]);
    const player = env({ role: "player", selected: ["t1", "t2"] });
    assert.equal(run(player.env, press({ key: "PageDown", code: "PageDown" })), "elevation");
    assert.deepEqual(player.calls.ops, [{ op: { t: "token.update", tokenId: "t2", patch: { elevation: 0 } } }], "only their own token");
    assert.equal(run(env({ role: "player", selected: ["t1"] }).env, press({ key: "PageUp", code: "PageUp" })), null);
  });

  test("an arrow moves the selection through the map's own drop", () => {
    const { env: e, scope } = env({ selected: ["t1"] });
    const moves: [number, number][] = [];
    scope.get(stageKeysSlot).nudge = (dx, dy) => void moves.push([dx, dy]);
    for (const key of ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"]) assert.equal(run(e, press({ key, code: key })), "nudge");
    assert.deepEqual(moves, [[0, -1], [1, 0], [0, 1], [-1, 0]]);
    assert.equal(run(env().env, press({ key: "ArrowUp", code: "ArrowUp" })), null, "nothing selected");
    assert.equal(run(e, press({ key: "ArrowUp", code: "ArrowUp", repeat: true })), null, "a held arrow moves once");
    // The token window's grip and handle take their arrows and prevent the default (docs/design-v1-token-window.md 4.3).
    assert.equal(run(e, press({ key: "ArrowLeft", code: "ArrowLeft", defaultPrevented: true, target: { tagName: "BUTTON" } })), null, "a key the window took moves no token");
    assert.equal(moves.length, 4);
  });

  test("a focused choice group or slider keeps the arrow and Page keys, and the selection stays put", () => {
    const { env: e, scope } = env({ selected: ["t1"] });
    const moves: [number, number][] = [];
    scope.get(stageKeysSlot).nudge = (dx, dy) => void moves.push([dx, dy]);
    const inside = (role: string) => ({ tagName: "LABEL", closest: (selector: string) => (selector.includes(`[role="${role}"]`) ? {} : null) });
    const targets = [
      { tagName: "INPUT", type: "radio" },
      { tagName: "input", type: "Range" },
      inside("radiogroup"),
      inside("slider"),
      inside("tablist"),
      inside("listbox"),
    ];
    for (const target of targets) {
      for (const key of ["ArrowRight", "ArrowDown", "PageUp", "PageDown"]) assert.equal(run(e, press({ key, code: key, target })), null, `${key} on ${JSON.stringify(target)}`);
    }
    assert.deepEqual(moves, [], "no token moved");
    assert.equal(run(e, press({ key: "v", code: "KeyV", target: targets[0] })), "tool:select", "letters still pick tools from a radio");
    assert.equal(run(e, press({ key: "ArrowRight", code: "ArrowRight", target: { tagName: "BUTTON", closest: () => null } })), "nudge", "a plain button leaves the arrows to the map");
  });

  test("N is Next for the DM and End turn for a player only on their own turn", () => {
    const dm = env({ turn: "theirs" });
    assert.equal(run(dm.env, press({ key: "n", code: "KeyN" })), "turn");
    assert.equal(dm.calls.ops[0]?.op.t, "encounter.next");
    assert.equal(run(env().env, press({ key: "n", code: "KeyN" })), null, "no fight");
    assert.equal(run(env({ role: "player", turn: "theirs" }).env, press({ key: "n", code: "KeyN" })), null);
    const mine = env({ role: "player", turn: "mine" });
    assert.equal(run(mine.env, press({ key: "n", code: "KeyN" })), "turn");
    assert.deepEqual(mine.calls.ops[0]?.op, { t: "encounter.next", from: { entry: "e1", round: 1 } });
  });

  test("S hides or shows the side panel from 900 px up, for the DM and players, by its key or its place", () => {
    for (const role of ["dm", "player"] as const) {
      const { env: e, scope } = env({ role });
      let toggled = 0;
      assert.equal(run(e, press({ key: "s", code: "KeyS" })), null, "below 900 px Room sets no toggle: there is no side panel");
      scope.get(sidePanelKeysSlot).toggle = () => void toggled++;
      assert.equal(run(e, press({ key: "s", code: "KeyS" })), "sidePanel");
      assert.equal(run(e, press({ key: "S", code: "KeyS", shiftKey: true })), "sidePanel");
      // Russian: the S key types ы.
      assert.equal(run(e, press({ key: "ы", code: "KeyS" })), "sidePanel");
      assert.equal(toggled, 3);
      assert.equal(run(e, press({ key: "s", code: "KeyS", target: { tagName: "INPUT", type: "text" } })), null, "typing in a field");
      assert.equal(run(e, press({ key: "s", code: "KeyS" }), { dialogOpen: true, preview: false }), null, "under a dialog");
      assert.equal(run(e, press({ key: "s", code: "KeyS" }), { dialogOpen: false, preview: true }), null, "in a preview");
      assert.equal(toggled, 3);
    }
  });

  test("the sheet lists each role's keys from the table itself", () => {
    const dm = shortcutsFor("dm").map((s) => s.keys);
    const player = shortcutsFor("player").map((s) => s.keys);
    for (const k of ["V", "T", "M", "F", "B", "G", "H", "L", "Delete, Backspace", "/", "?", "Ctrl+Z"]) assert.ok(dm.includes(k), k);
    for (const k of ["T", "F", "H", "L", "/"]) assert.ok(!player.includes(k), k);
    for (const k of ["V", "D", "Arrow keys", "N", "+", "?", "S"]) assert.ok(player.includes(k), k);
    assert.ok(dm.includes("S"));
  });
});

describe("the sheet's rows beside the keys", () => {
  const DESKTOP: SheetDevice = { mouse: true, android: false };
  const IPHONE: SheetDevice = { mouse: false, android: false };
  const ANDROID: SheetDevice = { mouse: false, android: true };
  const ROLES = ["dm", "player"] as const;

  const titles = (role: "dm" | "player", device: SheetDevice) => sheetSections(role, device).map((s) => s.title);
  const section = (role: "dm" | "player", device: SheetDevice, title: string) => sheetSections(role, device).find((s) => s.title === title);
  const inputs = (role: "dm" | "player", device: SheetDevice, title: string) => section(role, device, title)?.rows.map((r) => r.input) ?? [];

  test("every row has a role, a device, words for what you do and what it does, and a known surface", () => {
    const ids = new Set(SHORTCUTS.map((s) => s.id));
    for (const b of BEHAVIORS) {
      assert.ok(b.roles.length > 0 && b.roles.every((r) => r === "dm" || r === "player"), `${b.id} has a role`);
      assert.equal(new Set(b.roles).size, b.roles.length, `${b.id} names each role once`);
      assert.ok(["keys", "mouse", "android"].includes(b.device), `${b.id} has a device`);
      assert.ok(b.input.trim() && b.does.trim(), `${b.id} has words`);
      assert.ok(b.surface === undefined || (SURFACES as readonly string[]).includes(b.surface), `${b.id} names a known surface`);
      assert.ok(b.when === undefined || /^[a-z]/.test(b.when), `${b.id}: a condition starts in lowercase, as it follows the role`);
      assert.ok(!ids.has(b.id), `${b.id} is used once across both tables`);
      ids.add(b.id);
    }
  });

  test("it holds keys and key-plus-pointer combinations only, never a plain click, tap, drag or pinch", () => {
    for (const b of BEHAVIORS) {
      if (b.surface !== undefined) assert.equal(b.device, "keys", `${b.id}: a surface lists only its keys`);
      if (b.device !== "mouse") continue;
      // A mouse row names a key, or a button other than the left one, or the trackpad's pinch, which arrives as Ctrl and the wheel.
      assert.match(b.input, /^(Shift|Ctrl|Space|Right-click|Drag with the right or middle button)/, b.id);
    }
  });

  test("its words keep the house style: no em dash, no semicolon, no full stop at the end", () => {
    for (const b of BEHAVIORS) {
      for (const text of [b.input, b.does, b.when ?? ""]) {
        assert.ok(!/[\u2014;]/.test(text), `${b.id}: ${text}`);
        assert.ok(!text.endsWith("."), `${b.id}: ${text}`);
      }
    }
  });

  test("the mouse's rows show where there is a mouse or trackpad, and the Back button's on Android", () => {
    for (const role of ROLES) {
      assert.deepEqual(titles(role, DESKTOP).slice(0, 2), ["Keys", MOUSE_SECTION], role);
      assert.ok(!titles(role, DESKTOP).includes("Android"), role);
      assert.ok(!titles(role, IPHONE).includes(MOUSE_SECTION), role);
      assert.ok(!titles(role, IPHONE).includes("Android"), `${role}: an iPhone has no Back button of its own`);
      assert.deepEqual(titles(role, ANDROID).slice(0, 2), ["Keys", "Android"], role);
      assert.deepEqual(titles(role, { mouse: true, android: true }).slice(0, 3), ["Keys", MOUSE_SECTION, "Android"], role);
    }
    assert.deepEqual(inputs("player", DESKTOP, MOUSE_SECTION), [
      "Shift or Ctrl+click a token (Cmd on a Mac)",
      "Shift or Ctrl+drag on empty map (Cmd on a Mac)",
      "Right-click a token",
      "Drag with the right or middle button",
      "Space+drag",
      "Ctrl+wheel, or a pinch on a trackpad",
      "Ctrl+wheel, or a pinch on a trackpad",
    ]);
    assert.deepEqual(inputs("player", ANDROID, "Android"), ["Back button"]);
  });

  test("the sections come in order, Keys, the mouse, Android, then each surface, and an empty one is left out", () => {
    const order = ["Keys", MOUSE_SECTION, "Android", ...SURFACES];
    for (const role of ROLES) {
      for (const device of [DESKTOP, IPHONE, ANDROID]) {
        const got = titles(role, device);
        assert.deepEqual(got, [...got].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `${role} ${JSON.stringify(device)}`);
        for (const s of sheetSections(role, device)) assert.ok(s.rows.length > 0, s.title);
      }
    }
    assert.ok(titles("dm", IPHONE).includes("Label, pin and light panes"));
    assert.ok(!titles("player", IPHONE).includes("Label, pin and light panes"), "the panes are the DM's");
  });

  test("Keys holds the key table and then Escape, written as keys, and a surface's keys show on every device", () => {
    const keys = section("player", IPHONE, "Keys")!;
    assert.deepEqual(
      keys.rows.map((r) => r.id),
      [...shortcutsFor("player").map((s) => s.id), "escape"],
    );
    assert.ok(keys.rows.every((r) => r.keys));
    assert.ok(keys.intro?.startsWith("On any device with a keyboard."));
    for (const device of [DESKTOP, IPHONE, ANDROID]) {
      assert.deepEqual(inputs("player", device, "Handout viewer"), ["+, -", "0", "Arrow keys", "Page Down, Page Up", "Space, Shift+Space", "Home, End"]);
      assert.deepEqual(inputs("player", device, "Side panel tabs"), ["Left, Right", "Home, End"]);
    }
    assert.ok(section("dm", DESKTOP, MOUSE_SECTION)!.rows.every((r) => !r.keys), "a mouse row is a phrase, not a key");
  });

  test("the token window's section holds its keys, and the dialogs' section its own (docs/design-v1-token-window.md 11)", () => {
    assert.ok(SURFACES.includes("Token window"));
    assert.ok(!(SURFACES as readonly string[]).includes("Token action bar"), "the sheet never says window for two things");
    for (const role of ROLES) {
      const tokenWindow = section(role, IPHONE, "Token window")!;
      assert.deepEqual(tokenWindow.rows.map((r) => r.id), ["barEscape", "windowMoveKeys", "windowResizeKeys"]);
      assert.ok(tokenWindow.intro?.includes("never move a token"));
      assert.deepEqual(inputs(role, IPHONE, "Dialogs"), ["Escape", "Tab, Shift+Tab"]);
    }
    const keys = section("player", IPHONE, "Keys")!;
    assert.match(keys.intro ?? "", /a dialog is open/);
  });

  test("every row that names the mode says Multi-select", () => {
    for (const b of BEHAVIORS) assert.doesNotMatch(`${b.does} ${b.when ?? ""}`, /select several/i, b.id);
    assert.match(BEHAVIORS.find((b) => b.id === "selectAdd")!.does, /as Multi-select does$/);
    assert.match(BEHAVIORS.find((b) => b.id === "escape")!.does, /end Multi-select/);
    assert.equal(BEHAVIORS.find((b) => b.id === "selectMenu")!.when, "with Multi-select off");
  });

  test("each role sees its own rows", () => {
    assert.deepEqual(inputs("dm", IPHONE, "Initiative"), ["Enter", "Escape", "Enter"]);
    assert.deepEqual(inputs("player", IPHONE, "Initiative"), ["Enter", "Escape"], "only the DM types several values");
    assert.deepEqual(inputs("player", IPHONE, "Dialogs"), ["Escape", "Tab, Shift+Tab"]);
    assert.deepEqual(inputs("player", IPHONE, "Choose an image"), ["Ctrl+V (Cmd+V on a Mac)"]);
  });

  test("no section lists the same thing twice", () => {
    for (const role of ROLES) {
      for (const s of sheetSections(role, { mouse: true, android: true })) {
        const ids = s.rows.map((r) => r.id);
        assert.equal(new Set(ids).size, ids.length, `${role} ${s.title} ids`);
        const rows = s.rows.map((r) => `${r.input} | ${r.when ?? ""}`);
        assert.equal(new Set(rows).size, rows.length, `${role} ${s.title}: ${rows.join(", ")}`);
      }
    }
  });

  test("FEATURES.md's Shortcuts tables match the registries word for word", () => {
    const tables = shortcutTables(readFileSync(new URL("../../FEATURES.md", import.meta.url), "utf8"));
    const row = (b: Behavior) => [b.input, b.does, whoText(b)];
    const room = BEHAVIORS.filter((b) => b.surface === undefined);

    // The keys table words its rows as it always has, so every key in it is the registry's, and every registry key is in it.
    const split = (keys: string) => keys.split(", ");
    const tableKeys = (tables.get("Keys") ?? []).flatMap((r) => split(r[0] ?? ""));
    const registryKeys = [...SHORTCUTS.map((s) => s.keys), ...room.filter((b) => b.device === "keys").map((b) => b.input)].flatMap(split);
    assert.deepEqual([...tableKeys].sort(), [...registryKeys].sort(), "the Keys table");
    const escape = (tables.get("Keys") ?? []).find((r) => r[0] === "Escape");
    assert.deepEqual(escape, row(room.find((b) => b.id === "escape")!));

    assert.deepEqual(tables.get(MOUSE_SECTION), room.filter((b) => b.device === "mouse").map(row), "the mouse table");
    assert.deepEqual(tables.get("Android"), room.filter((b) => b.device === "android").map(row), "the Android table");
    for (const surface of SURFACES) {
      assert.deepEqual(tables.get(surface), BEHAVIORS.filter((b) => b.surface === surface).map(row), `the ${surface} table`);
    }
    assert.deepEqual([...tables.keys()], ["Keys", MOUSE_SECTION, "Android", ...SURFACES], "one table under each heading, in the sheet's order");
  });

  test("FEATURES.md repeats the sheet's intros word for word", () => {
    const intros = shortcutIntros(readFileSync(new URL("../../FEATURES.md", import.meta.url), "utf8"));
    for (const role of ROLES) {
      for (const s of sheetSections(role, { mouse: true, android: true })) assert.equal(intros.get(s.title) ?? null, s.intro ?? null, `${s.title}'s intro`);
    }
  });
});

/** The paragraph between each heading under FEATURES.md's Shortcuts and its table, where it has one. */
function shortcutIntros(markdown: string): Map<string, string> {
  const start = markdown.indexOf("\n## Shortcuts\n");
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  const intros = new Map<string, string>();
  for (const part of (next === -1 ? rest : rest.slice(0, next)).split("\n### ").slice(1)) {
    const [heading = "", ...lines] = part.split("\n");
    const text = lines.filter((l) => l.trim() !== "" && !l.startsWith("|"));
    if (text.length > 0) intros.set(heading.trim(), text.join(" ").trim());
  }
  return intros;
}

/** The rows of each table under FEATURES.md's Shortcuts, by the heading above it, as cells. */
function shortcutTables(markdown: string): Map<string, string[][]> {
  const start = markdown.indexOf("\n## Shortcuts\n");
  assert.ok(start >= 0, "FEATURES.md has a Shortcuts section");
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  const lines = (next === -1 ? rest : rest.slice(0, next)).split("\n");
  const tables = new Map<string, string[][]>();
  let heading: string | null = null;
  let header = false;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      heading = line.slice(4).trim();
      header = true;
      continue;
    }
    if (!heading || !line.startsWith("|")) continue;
    const cells = line.slice(1, -1).split("|").map((c) => c.trim());
    if (header) {
      // The table's heading row, then the line under it, where its rows start.
      if (cells[0] === "---") {
        header = false;
        tables.set(heading, []);
      }
      continue;
    }
    tables.get(heading)?.push(cells);
  }
  return tables;
}
