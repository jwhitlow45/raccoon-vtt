import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import { occupiedHexes, placedOnHex, tokenRefHex, type PlacedToken } from "#shared/rules/footprint.ts";
import { hexCenter, hexDistance, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { popoverSlot } from "../components/popoverRules.ts";
import { setKeyChanges } from "../features/device/settings.ts";
import { areaSlot } from "../features/areas/store.ts";
import { newDraft } from "../features/areas/placement.ts";
import { builderSlot } from "../features/builder/store.ts";
import { drawSlot } from "../features/drawings/store.ts";
import { areaCycle, builderCycle, drawCycle, fogCycle, placeCycle, rulerCycle, SPELL_HELD, trapCycle, type ToolCycle } from "../features/toolChoices.ts";
import { footprint, snapPosition } from "../lib/scene.ts";
import { viewerKey, viewerStart } from "../features/handouts/zoom.ts";
import { RoomScope } from "./scope.ts";
import { toolbarSlot, toolVoiceSlot } from "./toolbar.ts";
import { keyLabel, sameKey, type KeyMap } from "./keyBindings.ts";
import {
  BEHAVIORS,
  DEFAULT_KEYS,
  deletedText,
  hexNudge,
  isTextField,
  keyHint,
  surfaceKeyHint,
  keySuffix,
  keyText,
  sheetSections,
  SHORTCUTS,
  shortcutFor,
  shortcutKeys,
  shortcutSheetSlot,
  shortcutsFor,
  sidePanelKeysSlot,
  splitKeysSlot,
  stageKeysSlot,
  SURFACES,
  undoShortcut,
  VIEW_BEHAVIORS,
  VIEW_SHORTCUTS,
  whoText,
  withKey,
  ZOOM_STEP,
  MOUSE_SECTION,
  POINTER_SECTION,
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

  function env(input: { role?: "dm" | "player"; selected?: string[]; playersDraw?: "none" | "all" | string[]; turn?: "mine" | "theirs" | null; tool?: string; rows?: { id: string; tokenId: string; hidden: boolean }[] } = {}) {
    const role = input.role ?? "dm";
    const calls: Calls = { tool: [], ops: [], notes: [], panels: [], undo: 0, selected: [] };
    const tokens: Record<string, unknown> = {
      t1: { id: "t1", sceneId: "s1", name: "Goblin", number: 2, visibility: "all", locked: false, ownerIds: [], actor: {}, kind: "monster", elevation: 0 },
      t2: { id: "t2", sceneId: "s1", name: "Thorn", visibility: "dm", locked: true, ownerIds: ["p1"], actor: {}, kind: "pc", elevation: 5 },
    };
    const encounter = input.turn
      ? { round: 1, activeEntryId: "e1", entries: [{ id: "e1", tokenId: input.turn === "mine" ? "t2" : "t1", init: 10 }] }
      : input.rows
        ? { round: 1, activeEntryId: null, entries: input.rows }
        : null;
    const state = {
      you: { memberId: role === "dm" ? "dm1" : "p1", role },
      sceneId: "s1",
      pending: [],
      local: { selectedIds: input.selected ?? [], selectedId: input.selected?.at(-1) ?? null, tool: input.tool ?? "" },
      view: { tokens, characters: {}, encounter, meta: { settings: input.playersDraw === undefined ? {} : { playersDraw: input.playersDraw } } },
    };
    const scope = new RoomScope();
    const e: ShortcutEnv = {
      role,
      tools: (role === "dm" ? ["select", "ruler", "area", "draw", "ping", "add-token", "trap", "fog", "build", "grid"] : ["select", "ruler", "area", "draw", "ping"]).map((id) => ({ id })),
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
  /** The shortcut a press finds with some keys moved, as the sheet moves them on a device. */
  const moved = (changes: Record<string, string>) => {
    const keys: KeyMap = { ...DEFAULT_KEYS, ...changes };
    return (e: ShortcutEnv, p: KeyPress) => shortcutFor(p, e, open, keys)?.id ?? null;
  };

  describe("keys this device moved", () => {
    test("a moved letter matches as the room's letters do, and its old key picks nothing", () => {
      const { env: e } = env();
      const find = moved({ "tool:fog": "k" });
      assert.equal(find(e, press({ key: "k", code: "KeyK" })), "tool:fog");
      assert.equal(find(e, press({ key: "K", code: "KeyK", shiftKey: true })), "tool:fog", "with Shift");
      // Russian: the key at K types к.
      assert.equal(find(e, press({ key: "к", code: "KeyK" })), "tool:fog", "by its place on a Cyrillic layout");
      assert.equal(find(e, press({ key: "f", code: "KeyF" })), null, "F is free now");
      assert.equal(find(e, press({ key: "а", code: "KeyF" })), null, "and so is its place");
      assert.equal(find(e, press({ key: "k", code: "KeyK", target: { tagName: "INPUT", type: "text" } })), null, "typing in a field");
      assert.equal(find(e, press({ key: "k", code: "KeyK", ctrlKey: true })), null, "Ctrl+K stays the browser's");
      assert.equal(find(env({ role: "player" }).env, press({ key: "k", code: "KeyK" })), null, "Fog is still the DM's");
    });

    test("a moved symbol and a moved digit match by key, with Shift allowed", () => {
      const { env: e } = env();
      const find = moved({ "tool:fog": ",", "tool:ruler": "1" });
      assert.equal(find(e, press({ key: ",", code: "Comma" })), "tool:fog");
      // AZERTY: the key where QWERTY has M types a comma, which is Fog's now, ahead of the M of its place.
      assert.equal(find(e, press({ key: ",", code: "KeyM" })), "tool:fog", "the character typed wins over the letter of its place");
      // Greek: the key at G types γ.
      assert.equal(find(e, press({ key: "γ", code: "KeyG" })), "tool:grid", "a letter of another script still finds its place");
      assert.equal(find(e, press({ key: "1", code: "Digit1" })), "tool:ruler");
      // AZERTY: 1 takes Shift.
      assert.equal(find(e, press({ key: "1", code: "Digit1", shiftKey: true })), "tool:ruler");
      assert.equal(find(e, press({ key: "&", code: "Digit1" })), null, "the key's other character is not 1");
      assert.equal(find(e, press({ key: "r", code: "KeyR" })), null);
    });

    test("Zoom in's + takes = until it moves, and then neither picks it", () => {
      const { env: e, scope } = env();
      scope.get(stageKeysSlot).zoom = () => {};
      assert.equal(moved({})(e, press({ key: "=", code: "Equal" })), "zoomIn");
      const find = moved({ zoomIn: "z" });
      assert.equal(find(e, press({ key: "z", code: "KeyZ" })), "zoomIn");
      assert.equal(find(e, press({ key: "+", code: "Equal", shiftKey: true })), null);
      assert.equal(find(e, press({ key: "=", code: "Equal" })), null);
      assert.equal(find(e, press({ key: "z", code: "KeyZ", ctrlKey: true })), "undo", "Ctrl+Z is undo's whatever Z picks");
    });

    test("a press finds the device's own keys, and a change on another row's default wins over it", () => {
      assert.equal(shortcutKeys({ "tool:fog": "k" })["tool:fog"], "k");
      assert.equal(shortcutKeys({ "tool:fog": "v" })["tool:fog"], "v", "V was Select's");
      assert.equal(shortcutKeys({ "tool:fog": "v" })["tool:select"], "", "and Select has no key");
      assert.equal(shortcutKeys({ "tool:fog": "v", "tool:select": "f" })["tool:fog"], "v", "a swap holds");
      assert.equal(shortcutKeys({})["tool:fog"], "f");
      const clash = shortcutKeys({ "tool:fog": "x", "tool:ruler": "x" });
      assert.equal(clash["tool:fog"], "f", "two changes on X: neither holds");
      assert.equal(clash["tool:ruler"], "r");
      assert.equal(clash["tool:trap"], "x");
    });
  });

  test("a key picks a setup tool and a tool the pair hides, and the key of the tool in use shows its tucked options and never tucks (docs/design-v1-tool-options.md 5.5)", () => {
    const dm = env({ tool: "ruler" });
    assert.equal(run(dm.env, press({ key: "b", code: "KeyB" })), "tool:build", "behind Setup on a phone");
    assert.equal(run(dm.env, press({ key: "f", code: "KeyF" })), "tool:fog", "hidden by the pair");
    assert.deepEqual(dm.calls.tool, ["build", "fog"]);
    const toolbar = dm.scope.get(toolbarSlot);
    toolbar.setState({ tucked: "ruler" });
    assert.equal(run(dm.env, press({ key: "r", code: "KeyR" })), "tool:ruler");
    assert.equal(toolbar.getState().tucked, null, "shown again");
    assert.deepEqual(dm.calls.tool, ["build", "fog"], "the tool stays as it was");
    run(dm.env, press({ key: "r", code: "KeyR" }));
    assert.equal(toolbar.getState().tucked, null, "a second press never hides them");
  });

  test("X picks the Trap tool for the DM and does nothing for a player (D-261025-2)", () => {
    const dm = env();
    assert.equal(run(dm.env, press({ key: "x", code: "KeyX" })), "tool:trap");
    assert.deepEqual(dm.calls.tool, ["trap"]);
    assert.equal(shortcutKeys({})["tool:trap"], "x");
    const player = env({ role: "player" });
    assert.equal(run(player.env, press({ key: "x", code: "KeyX" })), null);
    assert.deepEqual(player.calls.tool, []);
  });

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

  test("H showing hidden tokens shows their hidden rows in the fight too, as one undo step, and hiding leaves rows alone", () => {
    const rows = [
      { id: "r2", tokenId: "t2", hidden: true },
      { id: "r1", tokenId: "t1", hidden: true },
    ];
    const showing = env({ selected: ["t2"], rows });
    assert.equal(run(showing.env, press({ key: "h", code: "KeyH" })), "hide");
    assert.deepEqual(showing.calls.ops, [
      { op: { t: "token.updateMany", tokenIds: ["t2"], patch: { visibility: "all" } }, group: "g1" },
      { op: { t: "encounter.update", entryId: "r2", patch: { hidden: false } }, group: "g1" },
    ]);
    const hiding = env({ selected: ["t1", "t2"], rows });
    run(hiding.env, press({ key: "h", code: "KeyH" }));
    assert.deepEqual(hiding.calls.ops, [{ op: { t: "token.updateMany", tokenIds: ["t1", "t2"], patch: { visibility: "dm" } } }]);
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
      inside("menu"),
    ];
    for (const target of targets) {
      for (const key of ["ArrowRight", "ArrowDown", "PageUp", "PageDown"]) assert.equal(run(e, press({ key, code: key, target })), null, `${key} on ${JSON.stringify(target)}`);
    }
    assert.deepEqual(moves, [], "no token moved");
    assert.equal(run(e, press({ key: "v", code: "KeyV", target: targets[0] })), "tool:select", "letters still pick tools from a radio");
    assert.equal(run(e, press({ key: "ArrowRight", code: "ArrowRight", target: { tagName: "BUTTON", closest: () => null } })), "nudge", "a plain button leaves the arrows to the map");
  });

  test("a letter a menu used for typeahead picks no tool, and S leaves the side panel alone", () => {
    const { env: e, scope } = env({ selected: ["t1"] });
    let toggled = 0;
    scope.get(sidePanelKeysSlot).toggle = () => void toggled++;
    const item = { tagName: "DIV", closest: (selector: string) => (selector.includes('[role="menu"]') ? {} : null) };
    assert.equal(run(e, press({ key: "r", code: "KeyR", target: item, defaultPrevented: true })), null, "R is typeahead there");
    assert.equal(run(e, press({ key: "s", code: "KeyS", target: item, defaultPrevented: true })), null, "S is typeahead there");
    assert.equal(toggled, 0);
    assert.equal(run(e, press({ key: "r", code: "KeyR", target: item })), "tool:ruler", "a letter the menu left alone still picks its tool");
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

  // docs/design-v1-split-panel.md 9.4.
  test("O goes to the other of two panels, for the DM and players, only while two show", () => {
    for (const role of ["dm", "player"] as const) {
      const { env: e, scope } = env({ role });
      let went = 0;
      assert.equal(run(e, press({ key: "o", code: "KeyO" })), null, "with one panel Room sets no slot");
      scope.get(splitKeysSlot).other = () => void went++;
      assert.equal(run(e, press({ key: "o", code: "KeyO" })), "otherPanel");
      assert.equal(run(e, press({ key: "щ", code: "KeyO" })), "otherPanel", "by its place on a Russian layout");
      assert.equal(run(e, press({ key: "o", code: "KeyO", target: { tagName: "TEXTAREA" } })), null, "O in a text field types");
      assert.equal(went, 2);
    }
  });

  // lib/fullscreen.ts. F stays the DM's Fog, and a letter matches with Shift too, so Shift+F is Fog as well.
  test("W enters and leaves full screen for the DM and players, only where the browser can, and never while typing", async () => {
    for (const role of ["dm", "player"] as const) {
      assert.equal(run(env({ role }).env, press({ key: "w", code: "KeyW" })), null, "where nothing can go full screen, as on iPhone Safari");
    }
    const asked: string[] = [];
    const doc = {
      fullscreenEnabled: true,
      fullscreenElement: null as unknown,
      documentElement: {
        requestFullscreen: async () => {
          asked.push("enter");
          doc.fullscreenElement = doc.documentElement;
        },
      },
      exitFullscreen: async () => {
        asked.push("leave");
        doc.fullscreenElement = null;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const global = globalThis as unknown as { document?: unknown };
    global.document = doc;
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
      for (const role of ["dm", "player"] as const) {
        const { env: e, calls } = env({ role });
        assert.equal(run(e, press({ key: "w", code: "KeyW" })), "fullscreen");
        await settle();
        assert.equal(run(e, press({ key: "W", code: "KeyW", shiftKey: true })), "fullscreen", "with Shift, as every letter");
        await settle();
        assert.equal(run(e, press({ key: "ц", code: "KeyW" })), "fullscreen", "by its place on a Russian layout");
        await settle();
        assert.equal(run(e, press({ key: "w", code: "KeyW", target: { tagName: "INPUT", type: "text" } })), null, "W in a text field types");
        assert.equal(run(e, press({ key: "w", code: "KeyW" }), { dialogOpen: true, preview: false }), null, "under a dialog");
        assert.equal(run(e, press({ key: "w", code: "KeyW", metaKey: true })), null, "Cmd+W stays the browser's");
        assert.equal(run(e, press({ key: "f", code: "KeyF" })), role === "dm" ? "tool:fog" : null, "F is still the DM's Fog");
        assert.deepEqual(calls.tool, role === "dm" ? ["fog"] : []);
      }
      assert.deepEqual(asked, ["enter", "leave", "enter", "leave", "enter", "leave"]);
    } finally {
      delete global.document;
    }
  });

  test("the split's grip, a separator, keeps the arrow and Page keys, so no token moves", () => {
    const { env: e } = env({ selected: ["t1"] });
    const grip = { tagName: "DIV", closest: (selector: string) => (selector.includes('[role="separator"]') ? {} : null) };
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]) assert.equal(run(e, press({ key, code: key, target: grip })), null, key);
  });

  test("every single key can move, and the defaults are written as the sheet writes them, one shortcut to a key", () => {
    assert.deepEqual(Object.keys(DEFAULT_KEYS).sort(), [
      "fit",
      "fullscreen",
      "hide",
      "lock",
      "otherPanel",
      "outliner",
      "sheet",
      "sidePanel",
      "tool:add-token",
      "tool:area",
      "tool:build",
      "tool:draw",
      "tool:fog",
      "tool:grid",
      "tool:pin",
      "tool:ping",
      "tool:ruler",
      "tool:select",
      "tool:trap",
      "turn",
      "turnLeft",
      "turnRight",
      "view",
      "zoomIn",
      "zoomOut",
    ]);
    for (const s of SHORTCUTS) {
      if (s.key === undefined) {
        assert.equal(typeof s.match, "function", `${s.id} matches by its own rule`);
        continue;
      }
      assert.equal(s.match, undefined, `${s.id} matches by its key`);
      assert.equal(s.keys, keyLabel(s.key), `${s.id}'s keys`);
      assert.ok(s.name.trim(), `${s.id} has a name`);
      assert.ok(!s.modifier, `${s.id} is one key`);
    }
    // The rows that stay: Ctrl or Cmd, the arrow and Page keys, Delete and Backspace.
    assert.deepEqual(SHORTCUTS.filter((s) => s.key === undefined).map((s) => s.id), ["undo", "redo", "nudge", "elevation", "delete"]);
    const defaults = Object.entries(DEFAULT_KEYS);
    for (const [id, key] of defaults) {
      const others = defaults.filter(([other, k]) => other !== id && sameKey(k, key)).map(([other]) => other);
      assert.deepEqual(others, [], `${id}'s ${key}, for the DM and players alike`);
    }
  });

  test("the sheet writes the key in effect, marks a moved one, and keyText says the same", () => {
    const keys: KeyMap = { ...DEFAULT_KEYS, "tool:fog": "x" };
    const rows = sheetSections("dm", { mouse: true, android: false }, keys)[0]!.rows;
    const row = (id: string) => rows.find((r) => r.id === id);
    assert.equal(row("tool:fog")?.input, "X");
    assert.deepEqual(row("tool:fog")?.rebind, { name: "Fog", changed: true });
    assert.deepEqual(row("tool:select")?.rebind, { name: "Select", changed: false });
    assert.equal(row("undo")?.rebind, undefined, "undo stays Ctrl+Z");
    assert.equal(row("escape")?.rebind, undefined);
    assert.equal(keyText("tool:fog", keys), "X");
    assert.equal(keyText("tool:fog", DEFAULT_KEYS), "F");
    assert.equal(keyText("undo", keys), "Ctrl+Z");
    assert.equal(sheetSections("dm", { mouse: true, android: false }, DEFAULT_KEYS)[0]!.rows.find((r) => r.id === "tool:fog")?.input, "F");
  });

  test("the sheet lists each role's keys from the table itself", () => {
    const dm = shortcutsFor("dm").map((s) => s.keys);
    const player = shortcutsFor("player").map((s) => s.keys);
    for (const k of ["V", "T", "M", "F", "B", "G", "H", "L", "Delete, Backspace", "/", "?", "Ctrl+Z"]) assert.ok(dm.includes(k), k);
    for (const k of ["T", "F", "H", "L", "/"]) assert.ok(!player.includes(k), k);
    for (const k of ["V", "D", "Arrow keys", "N", "+", "?", "S", "O"]) assert.ok(player.includes(k), k);
    assert.ok(dm.includes("S"));
    assert.ok(dm.includes("O"));
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
      assert.ok(["keys", "mouse", "android", "pointer"].includes(b.device), `${b.id} has a device`);
      assert.ok(b.input.trim() && b.does.trim(), `${b.id} has words`);
      assert.ok(b.surface === undefined || (SURFACES as readonly string[]).includes(b.surface), `${b.id} names a known surface`);
      assert.ok(b.when === undefined || /^[a-z]/.test(b.when), `${b.id}: a condition starts in lowercase, as it follows the role`);
      assert.ok(!ids.has(b.id), `${b.id} is used once across both tables`);
      ids.add(b.id);
    }
  });

  test("it holds keys and key-plus-pointer combinations, never a plain click or pinch, a plain tap only to pick the standee behind, and a plain drag only where it does more than move one token", () => {
    for (const b of BEHAVIORS) {
      if (b.surface !== undefined) assert.equal(b.device, "keys", `${b.id}: a surface lists only its keys`);
      // The drags of attached tokens (docs/design-v1-attach.md 4.6), which move a group or a mount, and the tap again on a standee, which picks one no plain tap reaches (docs/design-v1-isometric-view.md 6.2).
      if (b.device === "pointer") assert.match(b.input, /^(Drag .*(carries|carried|mount)|Tap a standee again$|Double click or tap on Undo or Redo$)/, b.id);
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

  test("the mouse's rows show where there is a mouse or trackpad, the drags' everywhere, and the Back button's on Android", () => {
    for (const role of ROLES) {
      assert.deepEqual(titles(role, DESKTOP).slice(0, 3), ["Keys", MOUSE_SECTION, POINTER_SECTION], role);
      assert.ok(!titles(role, DESKTOP).includes("Android"), role);
      assert.ok(!titles(role, IPHONE).includes(MOUSE_SECTION), role);
      assert.deepEqual(titles(role, IPHONE).slice(0, 2), ["Keys", POINTER_SECTION], `${role}: a phone drags with a finger`);
      assert.ok(!titles(role, IPHONE).includes("Android"), `${role}: an iPhone has no Back button of its own`);
      assert.deepEqual(titles(role, ANDROID).slice(0, 3), ["Keys", POINTER_SECTION, "Android"], role);
      assert.deepEqual(titles(role, { mouse: true, android: true }).slice(0, 4), ["Keys", MOUSE_SECTION, POINTER_SECTION, "Android"], role);
    }
    assert.deepEqual(inputs("player", IPHONE, POINTER_SECTION), ["Drag a token that carries others", "Drag the rider of a controlled mount", "Drag any other carried token", "Tap a standee again", "Double click or tap on Undo or Redo"]);
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

  test("the sections come in order, Keys, the mouse, the drags, Android, then each surface, and an empty one is left out", () => {
    const order = ["Keys", MOUSE_SECTION, POINTER_SECTION, "Android", ...SURFACES];
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
      assert.deepEqual(inputs("player", device, "Side panel tabs"), [
        "Left, Right",
        "Home, End",
        "Enter, Space, Down, Up on More",
        "Up, Down, Home, End in the list",
        "Letters in the list",
        "Enter, Space in the list",
        "Tab, Shift+Tab in the list",
        "Escape in the list",
      ]);
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

  test("the side panel's tabs and More's list are keys only, the same for the DM and players (docs/design-v1-panel-tabs.md 5.4)", () => {
    const rows = BEHAVIORS.filter((b) => b.surface === "Side panel tabs");
    assert.deepEqual(
      rows.map((b) => b.id),
      ["tabsSide", "tabsEnds", "tabsMoreKeys", "tabsListMove", "tabsListType", "tabsListPick", "tabsListLeave", "tabsListEscape"],
    );
    assert.ok(rows.every((b) => b.device === "keys" && b.roles.includes("dm") && b.roles.includes("player")));
    assert.ok(!BEHAVIORS.some((b) => b.id === "tabsWheel"), "the row no longer scrolls");
    assert.deepEqual(inputs("dm", DESKTOP, "Side panel tabs"), inputs("player", DESKTOP, "Side panel tabs"));
  });

  test("two panels: its own surface after the tabs, keys only, the same for the DM and players (docs/design-v1-split-panel.md 9.4)", () => {
    assert.equal(SURFACES.indexOf("Two panels"), SURFACES.indexOf("Side panel tabs") + 1);
    const rows = BEHAVIORS.filter((b) => b.surface === "Two panels");
    assert.deepEqual(
      rows.map((b) => b.id),
      ["splitGripKeys", "splitDragEscape", "splitNameKeys"],
    );
    assert.ok(rows.every((b) => b.device === "keys" && b.roles.includes("dm") && b.roles.includes("player")));
    assert.deepEqual(inputs("dm", DESKTOP, "Two panels"), inputs("player", DESKTOP, "Two panels"));
    assert.match(section("player", DESKTOP, "Two panels")?.intro ?? "", /never move a token/);
    const does = (id: string) => BEHAVIORS.find((b) => b.id === id)?.does ?? "";
    assert.match(does("tabsSide"), /on the panel open below, stop there and switch nothing/);
    assert.match(does("tabsEnds"), /switching as Left and Right do/);
    assert.match(does("tabsListPick"), /turn Two panels on or off/);
  });

  test("a tool's options keep their keys in their own section, on every device", () => {
    for (const role of ROLES) {
      for (const device of [DESKTOP, IPHONE, ANDROID]) assert.deepEqual(inputs(role, device, "Tool options"), ["Enter, Space", "Arrow keys"], `${role} ${JSON.stringify(device)}`);
    }
    assert.ok(section("player", IPHONE, "Tool options")?.intro?.startsWith("A tool's options row"));
  });

  test("each role sees its own rows", () => {
    assert.deepEqual(inputs("dm", IPHONE, "Initiative"), ["Enter", "Escape", "Enter"]);
    assert.deepEqual(inputs("player", IPHONE, "Initiative"), ["Enter", "Escape"], "only the DM types several values");
    assert.deepEqual(inputs("player", IPHONE, "Dialogs"), ["Escape", "Tab, Shift+Tab"]);
    assert.deepEqual(inputs("player", IPHONE, "Adding an image"), ["Ctrl+V (Cmd+V on a Mac)"]);
    assert.deepEqual(inputs("dm", IPHONE, "Adding an image"), ["Ctrl+V (Cmd+V on a Mac)"]);
    // A paste over the map is the DM's alone, in Keys after Escape.
    assert.deepEqual(section("dm", IPHONE, "Keys")!.rows.slice(-2).map((r) => r.id), ["escape", "roomPaste"]);
    assert.ok(!section("player", IPHONE, "Keys")!.rows.some((r) => r.id === "roomPaste"));
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
    assert.deepEqual(tables.get(POINTER_SECTION), room.filter((b) => b.device === "pointer").map(row), "the drags' table");
    assert.deepEqual(tables.get("Android"), room.filter((b) => b.device === "android").map(row), "the Android table");
    for (const surface of SURFACES) {
      assert.deepEqual(tables.get(surface), BEHAVIORS.filter((b) => b.surface === surface).map(row), `the ${surface} table`);
    }
    assert.deepEqual([...tables.keys()], ["Keys", MOUSE_SECTION, POINTER_SECTION, "Android", ...SURFACES], "one table under each heading, in the sheet's order");
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

describe("a second press of the tool's key moves through its main choice (docs/design-v1-tool-cycle.md)", () => {
  const CYCLES: Record<string, ToolCycle> = { ruler: rulerCycle, area: areaCycle, draw: drawCycle, fog: fogCycle, build: builderCycle, "add-token": placeCycle, trap: trapCycle };
  const LABELS: Record<string, string> = { select: "Select", ruler: "Ruler", area: "Area", draw: "Draw", ping: "Ping", "add-token": "Add token", pin: "Pin", trap: "Trap", fog: "Fog", build: "Map builder", grid: "Line up grid" };

  function room(input: { role?: "dm" | "player"; tool: string; playersDraw?: "none" | "all"; drawings?: Record<string, unknown> }) {
    const role = input.role ?? "dm";
    const calls = { tool: [] as string[] };
    const state = {
      you: { memberId: role === "dm" ? "dm1" : "p1", role },
      sceneId: "s1",
      local: { selectedIds: [], selectedId: null, tool: input.tool },
      view: {
        scenes: { s1: { id: "s1", fogEnabled: true, bounds: { w: 30, h: 20 } } },
        templates: {},
        tokens: {},
        drawings: input.drawings ?? {},
        members: {},
        encounter: null,
        meta: { settings: { feetPerCell: 5, ...(input.playersDraw ? { playersDraw: input.playersDraw } : {}) } },
      },
    };
    const scope = new RoomScope();
    const ids = role === "dm" ? Object.keys(LABELS) : ["select", "ruler", "area", "draw", "ping"];
    const e: ShortcutEnv = {
      role,
      tools: ids.map((id) => ({ id, label: LABELS[id]!, ...(CYCLES[id] ? { cycle: CYCLES[id] } : {}) })),
      getState: () => state as unknown as RoomView,
      actions: { sendEph: () => {}, newId: () => "n1", dispatch: () => 1 } as unknown as RoomActions,
      ui: { setTool: (id: string) => void calls.tool.push(id) } as unknown as RoomUi,
      scope,
    };
    const said = () => scope.get(toolVoiceSlot).getState();
    return { env: e, scope, calls, state, said };
  }

  const open = { dialogOpen: false, preview: false };
  const hit = (e: ShortcutEnv, p: KeyPress) => {
    const s = shortcutFor(p, e, open);
    s?.run(e, p);
    return s?.id ?? null;
  };
  const a = press({ key: "a", code: "KeyA" });
  const shiftA = press({ key: "A", code: "KeyA", shiftKey: true });
  const shape = (scope: RoomScope) => scope.get(areaSlot).store.getState().shape;

  test("A with another tool in use picks Area, its shape as it was, and says nothing", () => {
    const r = room({ tool: "ruler" });
    r.scope.get(areaSlot).store.setState({ shape: "cube" });
    assert.equal(hit(r.env, a), "tool:area");
    assert.deepEqual(r.calls.tool, ["area"]);
    assert.equal(shape(r.scope), "cube");
    assert.deepEqual(r.said(), { key: 0, text: "" });
  });

  test("A, then A: the next shape, said once each time, and Shift+A goes back, past the start to Emanation", () => {
    const r = room({ tool: "area" });
    hit(r.env, a);
    assert.equal(shape(r.scope), "sphere");
    assert.deepEqual(r.said(), { key: 1, text: "Area: Sphere" });
    hit(r.env, shiftA);
    assert.equal(shape(r.scope), "cone");
    hit(r.env, shiftA);
    assert.equal(shape(r.scope), "emanation");
    assert.deepEqual(r.said(), { key: 3, text: "Area: Emanation" });
    for (let i = 0; i < 6; i++) hit(r.env, a);
    assert.equal(shape(r.scope), "emanation", "six presses go round the six shapes");
    assert.equal(r.calls.tool.length, 0, "the tool stays");
  });

  test("a held key moves once, and Caps Lock never reverses", () => {
    const r = room({ tool: "area" });
    hit(r.env, a);
    for (let i = 0; i < 5; i++) assert.equal(hit(r.env, press({ key: "a", code: "KeyA", repeat: true })), null);
    assert.equal(shape(r.scope), "sphere");
    hit(r.env, press({ key: "A", code: "KeyA" }));
    assert.equal(shape(r.scope), "cylinder", "an A typed with Caps Lock goes forward");
  });

  test("tucked by a tap, A shows the options and moves in the same press", () => {
    const r = room({ tool: "area" });
    r.scope.get(toolbarSlot).setState({ tucked: "area" });
    hit(r.env, a);
    assert.equal(r.scope.get(toolbarSlot).getState().tucked, null);
    assert.equal(shape(r.scope), "sphere");
  });

  test("tucked while placing Fireball, A shows the options, keeps the spell and says why", () => {
    const r = room({ tool: "area" });
    const area = r.scope.get(areaSlot).store;
    area.setState({ draft: { ...newDraft("d1", "sphere", "#fff"), spell: "Fireball" } });
    r.scope.get(toolbarSlot).setState({ tucked: "area" });
    hit(r.env, a);
    assert.equal(r.scope.get(toolbarSlot).getState().tucked, null, "shown");
    assert.equal(area.getState().draft?.spell, "Fireball");
    assert.equal(area.getState().draft?.shape, "sphere");
    assert.deepEqual(r.said(), { key: 1, text: SPELL_HELD });
  });

  test("a press during a drag on the map moves nothing and says nothing, and moves again once it lifts", () => {
    const r = room({ tool: "draw" });
    let dragging = true;
    r.scope.get(stageKeysSlot).busy = () => dragging;
    hit(r.env, press({ key: "d", code: "KeyD" }));
    assert.equal(r.scope.get(drawSlot).store.getState().mode, "free", "the stroke goes on as Pen");
    assert.equal(r.said().key, 0);
    dragging = false;
    hit(r.env, press({ key: "d", code: "KeyD" }));
    assert.equal(r.scope.get(drawSlot).store.getState().mode, "line");
  });

  test("D eight times from Pen goes through Eraser and back to Pen, saying each", () => {
    const r = room({ tool: "draw" });
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      hit(r.env, press({ key: "d", code: "KeyD" }));
      seen.push(r.said().text);
    }
    assert.deepEqual(seen, ["Draw: Line", "Draw: Arrow", "Draw: Box", "Draw: Circle", "Draw: Shape", "Draw: Text", "Draw: Eraser", "Draw: Pen"]);
  });

  test("a held press, and the drag's, leave an open pop-up as it is, and a moving press closes it first", () => {
    const r = room({ tool: "draw" });
    const closed: string[] = [];
    const room_ = r.scope.get(popoverSlot);
    room_.open({ key: "stroke", where: () => "elsewhere", close: (why) => void (closed.push(why), room_.release("stroke")) });
    r.scope.get(drawSlot).store.setState({ mode: "polygon", draft: { kind: "polygon", points: [1, 1, 2, 2] } });
    hit(r.env, press({ key: "d", code: "KeyD" }));
    assert.deepEqual(closed, [], "held");
    r.scope.get(drawSlot).store.setState({ mode: "free", draft: null });
    r.scope.get(stageKeysSlot).busy = () => true;
    hit(r.env, press({ key: "d", code: "KeyD" }));
    assert.deepEqual(closed, [], "a drag");
    r.scope.get(stageKeysSlot).busy = null;
    hit(r.env, press({ key: "d", code: "KeyD" }));
    assert.deepEqual(closed, ["state"]);
    assert.equal(r.scope.get(drawSlot).store.getState().mode, "line");
  });

  test("D for a player whose drawing rights are off, with the eraser-only Draw in use, does nothing, as today", () => {
    const drawings = { d1: { id: "d1", sceneId: "s1", kind: "free", ownerId: "p1" } };
    const r = room({ role: "player", tool: "draw", playersDraw: "none", drawings });
    r.scope.get(drawSlot).store.setState({ mode: "erase" });
    assert.equal(hit(r.env, press({ key: "d", code: "KeyD" })), null);
    assert.equal(r.scope.get(drawSlot).store.getState().mode, "erase");
    assert.equal(r.said().key, 0);
  });

  test("V, P, M and G pressed again only show tucked options, and say nothing", () => {
    for (const [tool, key] of [["select", "v"], ["ping", "p"], ["pin", "m"], ["grid", "g"]] as const) {
      const r = room({ tool });
      r.scope.get(toolbarSlot).setState({ tucked: tool });
      assert.equal(hit(r.env, press({ key, code: `Key${key.toUpperCase()}` })), `tool:${tool}`);
      assert.equal(r.scope.get(toolbarSlot).getState().tucked, null, tool);
      assert.equal(r.said().key, 0, tool);
    }
  });

  test("B on a shape room with corners holds, and the status says why", () => {
    const r = room({ tool: "build" });
    r.scope.get(builderSlot).store.setState({ mode: "poly", poly: [{ x: 1, y: 1 }, { x: 2, y: 1 }] });
    hit(r.env, press({ key: "b", code: "KeyB" }));
    assert.equal(r.scope.get(builderSlot).store.getState().poly.length, 2);
    assert.deepEqual(r.said(), { key: 1, text: "Close or cancel the room first." });
    hit(r.env, press({ key: "b", code: "KeyB" }));
    assert.deepEqual(r.said(), { key: 2, text: "Close or cancel the room first." }, "a repeat is said again");
  });

  test("B ten times from Brush, then once more, and Shift+B from Brush: Stamp", () => {
    const r = room({ tool: "build" });
    const seen: string[] = [];
    for (let i = 0; i < 11; i++) {
      hit(r.env, press({ key: "b", code: "KeyB" }));
      seen.push(r.said().text.replace("Map builder: ", ""));
    }
    assert.deepEqual(seen, ["Rectangle room", "Shape room", "Erase", "Erase area", "Walls and doors", "Heights and stairs", "Difficult ground", "Label", "Lights", "Stamp", "Brush"]);
    hit(r.env, press({ key: "B", code: "KeyB", shiftKey: true }));
    assert.equal(r.scope.get(builderSlot).store.getState().mode, "stamp");
  });

  test("a moved key moves the choice: Area on K, Shift goes back on a moved letter with case, and a moved symbol always goes forward", () => {
    try {
      setKeyChanges({ "tool:area": "k" });
      const r = room({ tool: "area" });
      assert.equal(hit(r.env, a), null, "A does nothing");
      hit(r.env, press({ key: "k", code: "KeyK" }));
      assert.equal(shape(r.scope), "sphere");
      hit(r.env, press({ key: "K", code: "KeyK", shiftKey: true }));
      assert.equal(shape(r.scope), "cone");

      setKeyChanges({ "tool:area": "ñ" });
      // A Spanish layout's Ñ, with Shift, at the key QWERTY has the semicolon on.
      hit(r.env, press({ key: "Ñ", code: "Semicolon", shiftKey: true }));
      assert.equal(shape(r.scope), "emanation", "back one shape");

      setKeyChanges({ "tool:area": "!" });
      hit(r.env, press({ key: "!", code: "Digit1", shiftKey: true }));
      assert.equal(shape(r.scope), "cone", "Shift+1 goes forward");
      hit(r.env, press({ key: "!", code: "Digit1", shiftKey: true }));
      assert.equal(shape(r.scope), "sphere");

      setKeyChanges({ "tool:area": "1" });
      // AZERTY: 1 takes Shift.
      hit(r.env, press({ key: "1", code: "Digit1", shiftKey: true }));
      assert.equal(shape(r.scope), "cylinder", "a digit always goes forward");

      setKeyChanges({ "tool:area": "q" });
      // The binding decides, not what the key types: a layout whose Q key types a quote reaches Q by its place, and Shift still goes back.
      hit(r.env, press({ key: '"', code: "KeyQ", shiftKey: true }));
      assert.equal(shape(r.scope), "sphere", "back one shape");
    } finally {
      setKeyChanges({});
    }
  });

  test("500 random presses with and without Shift on each tool's list: the choice sits at the forward presses less the back ones, round the list", () => {
    // A fixed seed, so a failure repeats.
    let seed = 20261025;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const keyed = SHORTCUTS.filter((s) => s.id.startsWith("tool:") && CYCLES[s.id.slice(5)]);
    assert.equal(keyed.length, Object.keys(CYCLES).length, "every cycling tool has a key, and each is run");
    for (const s of keyed) {
      const id = s.id.slice(5);
      const r = room({ tool: id });
      const cycle = CYCLES[id]!;
      const first = cycle.now(r.env)!;
      const n = first.options.length;
      const start = first.options.findIndex((o) => o.value === first.value);
      let net = 0;
      for (let i = 0; i < 500; i++) {
        const back = random() < 0.4;
        const letter = s.key!;
        hit(r.env, press({ key: back ? letter.toUpperCase() : letter, code: `Key${letter.toUpperCase()}`, shiftKey: back }));
        net += back ? -1 : 1;
        const at = cycle.now(r.env)!.options.findIndex((o) => o.value === cycle.now(r.env)!.value);
        assert.equal(at, (((start + net) % n) + n) % n, `${id} after press ${i + 1}`);
      }
    }
  });
});

describe("arrow keys on a hex scene (docs/design-v1-hex-grids.md HX-D15)", () => {
  const press = (g: HexGrid, token: PlacedToken, step: readonly [number, number], times: number) => {
    const seen: Hex[] = [tokenRefHex(g, token)];
    let at = token;
    for (let i = 0; i < times; i++) {
      at = { ...at, ...hexNudge(g, at, step) };
      assert.deepEqual(snapPosition(g, at.x, at.y, footprint(at)), { x: at.x, y: at.y }, "on its anchor, as a drop lands");
      seen.push(tokenRefHex(g, at));
      assert.equal(hexDistance(g, seen[i]!, seen[i + 1]!), 1, "one hex a press");
    }
    return seen;
  };
  const medium = (g: HexGrid, hex: Hex): PlacedToken => ({ size: "medium", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, hex) });

  test("Arrow Up five times on hex rows keeps to one column, right of straight from an even row and left from an odd one", () => {
    const g: HexGrid = { shape: "hex", orient: "rows" };
    const seen = press(g, medium(g, { col: 4, row: 6 }), [0, -1], 5);
    assert.deepEqual(seen.map((h) => h.col), [4, 4, 4, 4, 4, 4]);
    assert.deepEqual(seen.map((h) => h.row), [6, 5, 4, 3, 2, 1]);
    const xs = seen.map((h) => hexCenter(g, h).x);
    assert.deepEqual(xs.slice(1).map((x, i) => Math.sign(x - xs[i]!)), [1, -1, 1, -1, 1], "a zigzag up one column");
    assert.deepEqual(press(g, medium(g, { col: 4, row: 6 }), [1, 0], 2).map((h) => [h.col, h.row]), [[4, 6], [5, 6], [6, 6]], "Right goes along the row");
  });

  test("hex columns mirror it: Left five times keeps to one row, and Up goes straight up its column", () => {
    const g: HexGrid = { shape: "hex", orient: "columns" };
    const seen = press(g, medium(g, { col: 6, row: 4 }), [-1, 0], 5);
    assert.deepEqual(seen.map((h) => h.row), [4, 4, 4, 4, 4, 4]);
    assert.deepEqual(seen.map((h) => h.col), [6, 5, 4, 3, 2, 1]);
    const ys = seen.map((h) => hexCenter(g, h).y);
    assert.deepEqual(ys.slice(1).map((y, i) => Math.sign(y - ys[i]!)), [1, -1, 1, -1, 1], "the mirror of the rows' zigzag");
    const up = press(g, medium(g, { col: 6, row: 4 }), [0, -1], 3).map((h) => hexCenter(g, h).x);
    assert.ok(up.every((x) => x === up[0]), "straight up");
  });

  test("a Large creature moves its top hex one hex, and keeps its three", () => {
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      const ogre: PlacedToken = { size: "large", ...placedOnHex(g, { size: "large", x: 0, y: 0 }, { col: 5, row: 5 }) };
      const seen = press(g, ogre, [0, 1], 4);
      assert.deepEqual(seen.map((h) => h.row), [5, 6, 7, 8, 9]);
      assert.equal(occupiedHexes(g, { ...ogre, ...hexNudge(g, ogre, [0, 1]) }).length, 3);
    }
  });
});

describe("a control shows the key of the shortcut it does (D-261028-09)", () => {
  /**
   * Every control that does what a shortcut does, by its shortcut and the
   * file that draws it. Each takes its key from keyHint: useKeyHint("id"),
   * a component's hints("id"), or a `shortcut` prop that does. The toolbar
   * stands for every tool's row, "tool:*", by one call for all of them.
   */
  const CONTROLS: readonly (readonly [id: string, file: string, control: string])[] = [
    ["undo", "client/pages/RoomChrome.tsx", "the top bar's Undo"],
    ["undo", "client/features/drawings/DrawTool.tsx", "Draw's Undo in its row"],
    ["undo", "client/features/drawings/DrawTool.tsx", "Draw's Undo beside a text or shape"],
    ["undo", "client/features/builder/Options.tsx", "the builder's Undo"],
    ["redo", "client/pages/RoomChrome.tsx", "the top bar's Redo"],
    ["redo", "client/features/drawings/DrawTool.tsx", "Draw's Redo"],
    ["redo", "client/features/builder/Options.tsx", "the builder's Redo"],
    ["tool:*", "client/pages/Room.tsx", "each tool's button, and its tile in Setup and the tool menu"],
    ["elevation", "client/canvas/TokenActionBar.tsx", "a token's Down 5 feet"],
    ["elevation", "client/canvas/TokenActionBar.tsx", "a token's Up 5 feet"],
    ["elevation", "client/canvas/TokenActionBar.tsx", "a group's All down 5 feet"],
    ["elevation", "client/canvas/TokenActionBar.tsx", "a group's All up 5 feet"],
    ["hide", "client/canvas/TokenActionBar.tsx", "a token's Hidden"],
    ["hide", "client/canvas/TokenActionBar.tsx", "a group's Hidden"],
    ["lock", "client/canvas/TokenActionBar.tsx", "a token's Locked"],
    ["lock", "client/canvas/TokenActionBar.tsx", "a group's Locked"],
    ["delete", "client/canvas/TokenActionBar.tsx", "Delete, a token's and a group's"],
    ["turn", "client/panels/TrackerPanel.tsx", "the DM's Start and Next"],
    ["turn", "client/features/encounter/parts.tsx", "a player's End turn, in the tracker and the phone's band"],
    ["fit", "client/pages/RoomChrome.tsx", "the top bar's Fit"],
    ["view", "client/pages/RoomChrome.tsx", "the top bar's View"],
    ["view", "client/panels/MenuPanel.tsx", "the room menu's View row, where the bar folds the button away"],
    ["turnLeft", "client/features/view/ViewMenu.tsx", "the View menu's Turn left"],
    ["turnRight", "client/features/view/ViewMenu.tsx", "the View menu's Turn right"],
    ["outliner", "client/features/outliner/OutlinerPanel.tsx", "the outliner's search field"],
    ["sidePanel", "client/pages/SideTabs.tsx", "Hide panels"],
    ["sidePanel", "client/pages/Room.tsx", "Panels, while the side panel is hidden"],
    ["fullscreen", "client/pages/RoomChrome.tsx", "the top bar's Full screen"],
    ["sheet", "client/features/device/ThisDevice.tsx", "Menu, This device's Show the shortcuts"],
  ];
  /** The shortcuts no control does, and why. */
  const NO_CONTROL: Readonly<Record<string, string>> = {
    nudge: "a token moves by a drag, never by a button",
    zoomIn: "the map zooms by a pinch or the wheel. The handout viewer's own + and - are its own keys",
    zoomOut: "the map zooms by a pinch or the wheel",
    otherPanel: "the other panel is reached by a tap on it",
  };
  const ids = [...new Set([...SHORTCUTS, ...VIEW_SHORTCUTS].map((s) => (s.id.startsWith("tool:") ? "tool:*" : s.id)))];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const calls = (source: string, id: string) =>
    id === "tool:*"
      ? source.split("hints(`tool:${").length - 1
      : (source.match(new RegExp(`(?:useKeyHint|hints)\\("${escape(id)}"|shortcut=(?:"${escape(id)}"|\\{[^}]*"${escape(id)}"\\})`, "g")) ?? []).length;

  test("every shortcut lists the controls that do it, or why none does", () => {
    const listed = new Set(CONTROLS.map(([id]) => id));
    for (const id of ids) assert.ok(listed.has(id) !== (id in NO_CONTROL), `${id}: listed with controls, or with a reason for none, and not both`);
    for (const id of [...listed, ...Object.keys(NO_CONTROL)]) assert.ok(ids.includes(id), `${id} is no shortcut`);
  });

  test("each control takes its key from the shortcut table", () => {
    const wanted = new Map<string, number>();
    for (const [id, file] of CONTROLS) wanted.set(`${file} ${id}`, (wanted.get(`${file} ${id}`) ?? 0) + 1);
    for (const [at, count] of wanted) {
      const [file, id] = at.split(" ") as [string, string];
      const found = calls(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), id);
      assert.ok(found >= count, `${file}: ${count} control(s) for ${id}, ${found} taking its key`);
    }
  });

  test("the key is the sheet's: each single key as the sheet writes it, moved or not, and a fixed row's own words", () => {
    for (const s of [...SHORTCUTS, ...VIEW_SHORTCUTS]) {
      for (const role of s.roles) {
        const hint = keyHint(s.id, role, DEFAULT_KEYS);
        if (s.key !== undefined) assert.equal(hint?.text, keyText(s.id, DEFAULT_KEYS), `${s.id} for the ${role}`);
        else if (hint) assert.equal(hint.text, s.keys, `${s.id}'s own words`);
      }
    }
    assert.deepEqual(keyHint("turnLeft", "player", DEFAULT_KEYS), { text: "Q", aria: "Q" });
    assert.deepEqual(keyHint("view", "dm", DEFAULT_KEYS), { text: "I", aria: "I" });
    assert.deepEqual(keyHint("sheet", "player", DEFAULT_KEYS), { text: "?", aria: "?" });
    assert.deepEqual(keyHint("tool:fog", "dm", { ...DEFAULT_KEYS, "tool:fog": "k" }), { text: "K", aria: "K" }, "a moved key");
    assert.equal(keyHint("tool:fog", "dm", { ...DEFAULT_KEYS, "tool:fog": "" }), null, "a key this device took away");
    assert.deepEqual(keyHint("zoomIn", "dm", DEFAULT_KEYS), { text: "+", aria: "Plus" }, "+ joins keys in aria-keyshortcuts, so it has a name there");
  });

  test("the fixed rows: Ctrl or Cmd with Z, each key of Page Up and Page Down, and Delete with Backspace", () => {
    assert.deepEqual(keyHint("undo", "player", DEFAULT_KEYS), { text: "Ctrl+Z", aria: "Control+Z Meta+Z" });
    assert.deepEqual(keyHint("redo", "dm", DEFAULT_KEYS), { text: "Ctrl+Shift+Z", aria: "Control+Shift+Z Meta+Shift+Z" });
    assert.deepEqual(keyHint("elevation", "dm", DEFAULT_KEYS, 0), { text: "Page Up", aria: "PageUp" });
    assert.deepEqual(keyHint("elevation", "player", DEFAULT_KEYS, 1), { text: "Page Down", aria: "PageDown" });
    assert.deepEqual(keyHint("elevation", "dm", DEFAULT_KEYS), { text: "Page Up, Page Down", aria: "PageUp PageDown" });
    assert.equal(keyHint("elevation", "dm", DEFAULT_KEYS, 2), null);
    assert.deepEqual(keyHint("delete", "dm", DEFAULT_KEYS), { text: "Delete, Backspace", aria: "Delete Backspace" });
    assert.equal(keyHint("nudge", "dm", DEFAULT_KEYS), null, "no control does it, so it has no attribute's names");
  });

  test("none for a role whose key does nothing, or a shortcut the table does not hold", () => {
    for (const id of ["hide", "lock", "delete", "outliner", "tool:fog", "tool:build"]) {
      assert.equal(keyHint(id, "player", DEFAULT_KEYS), null, `${id} is the DM's`);
      assert.notEqual(keyHint(id, "dm", DEFAULT_KEYS), null, `${id} for the DM`);
    }
    assert.equal(keyHint("nothing", "dm", DEFAULT_KEYS), null);
  });

  test("a name with its key, and the words after a name", () => {
    const hint = keyHint("turnRight", "dm", DEFAULT_KEYS);
    assert.equal(withKey("Turn right", hint), "Turn right (E)");
    assert.equal(keySuffix(hint), " (E)");
    assert.equal(withKey("Turn right", null), "Turn right");
    assert.equal(keySuffix(null), "");
  });
});

describe("a surface's own buttons show its fixed keys, apart from the room's (D-261028-09)", () => {
  /** The buttons that do what a surface's fixed key does, by its sheet row and the file that draws them, each taking its key from useSurfaceKeyHint. */
  const SURFACE_CONTROLS: readonly (readonly [id: string, file: string, control: string])[] = [
    ["viewerZoom", "client/features/handouts/HandoutViewer.tsx", "the handout viewer's Zoom in"],
    ["viewerZoom", "client/features/handouts/HandoutViewer.tsx", "the handout viewer's Zoom out"],
    ["viewerReset", "client/features/handouts/HandoutViewer.tsx", "the handout viewer's Reset zoom"],
    ["setupUndo", "client/panels/SetupHistory.tsx", "Setup history's Undo setup"],
    ["setupRedo", "client/panels/SetupHistory.tsx", "Setup history's Redo setup"],
  ];

  test("each surface button takes its key from the sheet's row", () => {
    const wanted = new Map<string, number>();
    for (const [id, file] of SURFACE_CONTROLS) wanted.set(`${file} ${id}`, (wanted.get(`${file} ${id}`) ?? 0) + 1);
    for (const [at, count] of wanted) {
      const [file, id] = at.split(" ") as [string, string];
      const found = (readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").match(new RegExp(`useSurfaceKeyHint\\("${id}"`, "g")) ?? []).length;
      assert.ok(found >= count, `${file}: ${count} control(s) for ${id}, ${found} taking its key`);
    }
  });

  test("the handout viewer's keys are the sheet's and the viewer's own: + or = zooms in, - zooms out, 0 resets", () => {
    assert.deepEqual(surfaceKeyHint("viewerZoom", 0), { text: "+", aria: "Plus =" });
    assert.deepEqual(surfaceKeyHint("viewerZoom", 1), { text: "-", aria: "-" });
    assert.deepEqual(surfaceKeyHint("viewerReset"), { text: "0", aria: "0" });
    assert.equal(surfaceKeyHint("viewerZoom", 2), null);
    assert.equal(surfaceKeyHint("viewerArrows"), null, "the arrows move the picture, which no button does");
    // Each name the attribute gives is a key the viewer answers with that button's action.
    const s = viewerStart(true);
    const pressed = (aria: string) => aria.split(" ").map((name) => viewerKey(name === "Plus" ? "+" : name, s));
    assert.deepEqual(pressed(surfaceKeyHint("viewerZoom", 0)!.aria), [{ t: "in" }, { t: "in" }]);
    assert.deepEqual(pressed(surfaceKeyHint("viewerZoom", 1)!.aria), [{ t: "out" }]);
    assert.deepEqual(pressed(surfaceKeyHint("viewerReset")!.aria), [{ t: "reset" }]);
  });

  test("kept apart from the room's keys: no device moves them, and the room's table does not hold them", () => {
    for (const id of ["viewerZoom", "viewerReset", "setupUndo", "setupRedo"]) {
      assert.equal(keyHint(id, "dm", DEFAULT_KEYS), null, id);
      assert.ok(!(id in DEFAULT_KEYS), `${id} is no binding`);
      assert.ok(!SHORTCUTS.some((s) => s.id === id), `${id} is no room shortcut`);
    }
  });

  test("Setup history's buttons expose the keys its focused shortcuts handle", () => {
    assert.deepEqual(surfaceKeyHint("setupUndo"), { text: "Ctrl+Z (Cmd+Z on a Mac)", aria: "Control+Z Meta+Z" });
    assert.deepEqual(surfaceKeyHint("setupRedo"), { text: "Ctrl+Shift+Z (Cmd+Shift+Z on a Mac)", aria: "Control+Shift+Z Meta+Shift+Z" });
  });
});

test("focused setup keys preserve native editing, repeated keys, and other dialogs", async () => {
  const { setupHistoryShortcut } = await import("./shortcuts.ts");
  const yes = { focused: true, dm: true, preview: false, confirming: false, scope: "setup" as const };
  const key = press({ key: "z", code: "KeyZ", ctrlKey: true });
  assert.equal(setupHistoryShortcut(key, yes), "undo");
  assert.equal(setupHistoryShortcut({ ...key, shiftKey: true }, yes), "redo");
  for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { isContentEditable: true }]) assert.equal(setupHistoryShortcut({ ...key, target }, yes), null);
  assert.equal(setupHistoryShortcut({ ...key, repeat: true }, yes), null);
  assert.equal(setupHistoryShortcut(key, { ...yes, scope: "play" }), null, "the retained Play sheet keeps the usual dialog key boundary");
  for (const no of [{ focused: false }, { dm: false }, { preview: true }, { confirming: true }]) assert.equal(setupHistoryShortcut(key, { ...yes, ...no }), null);
});
