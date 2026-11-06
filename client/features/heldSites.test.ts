import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { DM, character, room } from "#shared/testutil.ts";
import type { ReactElement, ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { tokenPattern } from "../components/testing/tokenPattern.ts";

const { createElement, isValidElement, cloneElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { drawn } = await import("../components/testing/drawn.ts");
const { Held } = await import("../components/Held.tsx");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../state/scope.ts");
const { RequestSheet } = await import("./rolls/RequestSheet.tsx");
const { ResourceSheet } = await import("./resources/ResourceSheet.tsx");
const { JournalEditor } = await import("./journal/JournalEditor.tsx");
const { PinEditor } = await import("./pins/PinPane.tsx");
const { NumbersStep } = await import("./tokens/CompanionBlocks.tsx");
const { EffectPicker } = await import("./tokens/EffectsSection.tsx");

/*
 * LOCKED-LOOK at the sites that hold a group of controls (docs/design/design-v1-look-pass-1.md).
 * Each site must hold its group with `Held`, not a bare fieldset with the
 * disabled look told to controls one by one. A control that was never told
 * is the bug class this guards: the browser stops it, and it still draws
 * enabled. So each site's tree is searched for its `Held`, the group is
 * forced held, and the controls inside, which carry no `disabled` of their
 * own, must be off and draw `textDisabled`.
 */

function inRoom(child: ReactElement): ReactElement {
  const store = createStore(() => ({ view: room({ characters: { bree: character("bree", { name: "Bree" }) } }), roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return createElement(RoomProvider, {
    store: store as never,
    actions: { dispatch: () => 1, newId: () => "id" } as never,
    ui: { notify() {} } as never,
    assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child }),
  });
}

type HeldElement = ReactElement<{ held: boolean }>;

/** The first `Held` a site draws, found through element children alone, so no component below it runs. */
function heldIn(node: ReactNode): HeldElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = heldIn(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === Held) return node as HeldElement;
  return heldIn((node.props as { children?: ReactNode }).children);
}

const dim = new RegExp(`color:${tokenPattern(theme.color.textDisabled)}`, "i");

/** The group a site draws, with `held` as the site set it and then forced on. */
function groupOf(tree: ReactNode): { free: string; held: string } {
  const as = heldIn(tree);
  assert.ok(as, "the site holds its controls with Held");
  return {
    free: renderToStaticMarkup(inRoom(cloneElement(as, { held: false }))),
    held: renderToStaticMarkup(inRoom(cloneElement(as, { held: true }))),
  };
}

/** The opening tag of the control named `label`. */
function tagOf(markup: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`<(?:button|input|select|textarea|div)\\b[^>]*aria-label="${escaped}"[^>]*>`).exec(markup)?.[0];
  assert.ok(found, `a control named ${label}`);
  return found;
}

/** A control the group holds: natively off, and drawn dim by its own look. */
function assertOff(markup: string, label: string) {
  const tag = tagOf(markup, label);
  assert.match(tag, /\sdisabled=""|aria-disabled="true"/, `${label} is off`);
  assert.match(tag, dim, `${label} draws textDisabled`);
}

/** The words of an options row (a Segmented) draw dim: its labels carry the color, not the group. */
function assertOptionsDim(markup: string, group: string) {
  const at = markup.indexOf(tagOf(markup, group));
  assert.match(markup.slice(at).match(/<label[^>]*>/)?.[0] ?? "", dim, `${group} options draw textDisabled`);
}

function checkSite(name: string, draw: () => ReactNode, named: { off?: string[]; options?: string[] }) {
  test(name, () => {
    const { free, held } = groupOf(draw());
    assert.match(held, /^<fieldset disabled=""/);
    for (const label of named.off ?? []) assertOff(held, label);
    for (const label of named.options ?? []) assertOptionsDim(held, label);
    // Free, a control that is off for its own reason (a first block cannot move up) is the only dim one.
    const dimmed = (markup: string) => markup.match(new RegExp(dim.source, "gi"))?.length ?? 0;
    assert.ok(dimmed(held) > dimmed(free), "held, the group draws more dim than free");
    for (const label of named.off ?? []) assert.doesNotMatch(tagOf(free, label), dim, `${label} draws enabled when free`);
    assert.doesNotMatch(free, /^<fieldset disabled=""/);
  });
}

describe("the sites that hold a group of controls draw it off through Held (LOCKED-LOOK)", () => {
  checkSite("the roll request sheet", () => drawn(RequestSheet as never, { from: { kind: "free" }, onClose() {} } as never, inRoom), {
    off: ["Skill check", "DC"],
    options: ["Saving throw", "Ability check"],
  });

  checkSite(
    "the class resource sheet",
    () => drawn(ResourceSheet as never, { character: character("bree", { name: "Bree", level: 5 }), mode: { kind: "add" }, opener: { current: null }, onClose() {} } as never, inRoom),
    { off: ["Class"], options: ["Add from"] },
  );

  checkSite("the journal editor", () => drawn(JournalEditor as never, { page: null, folders: [], onClose() {}, onSaved() {} } as never, inRoom), {
    off: ["Block 1 text", "Delete block 1"],
  });

  checkSite(
    "the pin pane",
    () => drawn(PinEditor as never, { pin: { id: "pin1", rev: 1, sceneId: "s1", x: 1, y: 1, color: "#e0635a", visibility: "all" }, onClose() {}, dismissRef: { current() {} }, sheet: false } as never, inRoom),
    { off: ["Pin label", "Linked page"] },
  );

  checkSite(
    "the companion numbers step",
    () =>
      drawn(
        NumbersStep as never,
        {
          token: { name: "Hoot" },
          actor: undefined,
          block: "Owl",
          numbers: { patch: {}, lines: ["AC 13"], size: "small", average: 5, max: null, hpLine: "" },
          sizeLine: null,
          frozen: false,
          use: true,
          onUse() {},
          hp: { kind: "typed", value: null },
          onHp() {},
        } as never,
        inRoom,
      ),
    { options: ["Numbers", "Max HP"] },
  );
});

describe("the condition tiles read the held group", () => {
  const picker = () => createElement(EffectPicker, { present: [], onPick() {} });

  test("held, every tile is off and draws textDisabled, and free they act", () => {
    const held = renderToStaticMarkup(createElement(Held, { held: true, children: picker() }));
    const tiles = held.match(/<button\b[^>]*>/g) ?? [];
    assert.ok(tiles.length > 20, `every condition and status is a tile (${tiles.length})`);
    for (const tile of tiles) {
      assert.match(tile, /\sdisabled=""/);
      assert.match(tile, dim);
    }
    const free = renderToStaticMarkup(createElement(Held, { held: false, children: picker() }));
    assert.doesNotMatch(free, /<button\b[^>]*\sdisabled=""/);
    assert.doesNotMatch(free, dim);
  });
});

/*
 * The group save page offline: the page's whole setup and outcome sit in one
 * held group, and the browser stopped them while many still drew `text` and
 * the chosen ones the accent (the seen case in the design note).
 */
describe("the group save page, offline, draws its setup and outcome off", () => {
  async function drawPage(connection: "open" | "closed"): Promise<string> {
    const panelModule = await import("./dice/useDicePanel.ts");
    const { newPage } = await import("./dice/groupSave/chain.ts");
    const { groupRows } = await import("./dice/groupSave/rows.ts");
    const { groupSaveSlot } = await import("./dice/groupSave/store.ts");
    const { GroupSave } = await import("./dice/groupSave/GroupSave.tsx");
    const { actor, token } = await import("#shared/testutil.ts");
    const view = room({ tokens: { g1: token("g1", { name: "Guard", actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 } }) } }) } });
    const kind = { kind: "save", ability: "dex" } as const;
    const page = {
      ...newPage({ id: "p", sceneId: "s1", source: { kind: "selection", tokenIds: ["g1"] }, test: kind, dc: 13, secret: false, spell: false, switches: { dcShown: true, resultShown: true }, outcome: { damage: "8d6 fire", conditions: ["prone"] } }),
      rows: groupRows({ view, you: DM, srd: { monsters: [], rolls: {} } } as never, ["g1"], kind, false),
    };
    const scope = new RoomScope();
    // A server render reads a store's initial state.
    const panel = scope.get(panelModule.diceChoicesSlot);
    panel.getInitialState = panel.getState;
    const saves = scope.get(groupSaveSlot);
    saves.setState({ page, reopen: null });
    saves.getInitialState = saves.getState;
    const store = createStore(() => ({ view, roomId: "r1", connection, you: DM, sceneId: "s1", local: { selectedIds: ["g1"], multi: false } }));
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1 } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope, children: createElement(GroupSave, { parent: "Dice", onBack() {} }) }),
      }),
    );
  }

  const switches = (markup: string) => markup.match(/<button\b[^>]*role="switch"[^>]*>/g) ?? [];

  test("offline, the Ability and It lasts selects, the damage field and both switches are off and dim", async () => {
    const markup = await drawPage("closed");
    assertOff(markup, "Ability");
    assertOff(markup, "It lasts");
    const damage = /<input\b[^>]*placeholder="8d6 fire, or 28"[^>]*>/.exec(markup)?.[0];
    assert.ok(damage);
    assert.match(damage, /\sdisabled=""/);
    assert.match(damage, dim);
    assert.equal(switches(markup).length, 2);
    for (const tag of switches(markup)) {
      assert.match(tag, /\sdisabled=""/);
      assert.match(tag, dim);
    }
    assertOptionsDim(markup, tagLabelOf(markup, /aria-label="([^"]*: fail, pass or skip)"/));
  });

  test("online, the same controls act and draw enabled", async () => {
    const markup = await drawPage("open");
    assert.doesNotMatch(tagOf(markup, "Ability"), dim);
    assert.doesNotMatch(tagOf(markup, "It lasts"), dim);
    for (const tag of switches(markup)) assert.doesNotMatch(tag, dim);
  });
});

function tagLabelOf(markup: string, pattern: RegExp): string {
  const label = pattern.exec(markup)?.[1];
  assert.ok(label, `a control matching ${pattern}`);
  return label;
}

describe("the dice set picker, with Roll animation off, is a held group", () => {
  async function drawPicker(): Promise<string> {
    const { DiceSetPicker } = await import("./device/DiceSetPicker.tsx");
    return renderToStaticMarkup(inRoom(createElement(DiceSetPicker)));
  }

  test("off, the fieldset is held, the legend and the chosen tile draw off, and on they act", async () => {
    const { setRollAnimation } = await import("./device/settings.ts");
    try {
      setRollAnimation(false);
      const off = await drawPicker();
      // Held rather than a bare fieldset, so a shared control added to the picker later reads the group too.
      const { DiceSetPicker } = await import("./device/DiceSetPicker.tsx");
      assert.equal(heldIn(drawn(DiceSetPicker as never, {} as never, inRoom))?.props.held, true);
      assert.match(off, /^<fieldset disabled=""/);
      assert.match(off, new RegExp(`<legend[^>]*color:${tokenPattern(theme.color.textDisabled)}`, "i"));
      // The radios are native, so the fieldset stops them. The tiles keep their own look inside it (tileStyle).
      assert.match(off, new RegExp(`<label[^>]*box-shadow:inset 0 0 0 1px ${tokenPattern(theme.color.textDisabled)}`, "i"));
      setRollAnimation(true);
      const on = await drawPicker();
      assert.doesNotMatch(on, /^<fieldset disabled=""/);
      assert.equal(heldIn(drawn(DiceSetPicker as never, {} as never, inRoom))?.props.held, false);
      assert.doesNotMatch(on, new RegExp(`<legend[^>]*color:${tokenPattern(theme.color.textDisabled)}`, "i"));
    } finally {
      setRollAnimation(true);
    }
  });
});
