import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ReactElement } from "react";
import type { MenuItem } from "./Menu.tsx";
import type { PopoverHandle } from "./Popover.tsx";

/*
 * Menu items with their own content, look, marks, names and presses
 * (docs/design/design-v1-stat-block-rolls.md 4.7 and 10), as an ability's list
 * draws its rows. An item without them draws as before.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Menu, focusMove, openingAt } = await import("./Menu.tsx");
const { Popover, usePopoverContext } = await import("./Popover.tsx");
const { Held } = await import("./Held.tsx");
const { theme } = await import("../lib/theme.ts");

type Props = Parameters<typeof Menu>[0];
type Node = { props: Record<string, unknown> & { children?: unknown } };

function handle(closes: string[]): PopoverHandle {
  return { open: true, kind: "menu", contentId: "m", anchor: { current: null }, box: { current: null }, focusInside: { current: null }, how: { by: "key", from: "first" }, close: (reason: string) => closes.push(reason) } as unknown as PopoverHandle;
}

/** How the menu is drawn: inside a held group, or with the popover's placement already made, as Popover's place would make it. */
type Around = { held?: boolean; placed?: Record<string, unknown> };

/** Renders the menu in an open popover, and keeps the element tree Menu returned, whose handlers a test calls as React would. */
function draw(props: Props, closes: string[] = [], around: Around = {}): { html: string; root: Node; items: Node[] } {
  let tree: ReactElement | null = null;
  function Probe() {
    const context = usePopoverContext();
    if (around.placed) (context.placed as { current: unknown }).current = around.placed;
    tree = Menu(props) as ReactElement;
    return tree;
  }
  const popover = createElement(Popover, { handle: handle(closes), side: "above", bound: { left: 0, top: 0, right: 400, bottom: 800 }, children: createElement(Probe) });
  const html = renderToStaticMarkup(around.held ? createElement(Held, { held: true, children: popover }) : popover);
  assert.ok(tree);
  const items: Node[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const n = node as Node;
    if (typeof n.props.role === "string" && n.props.role.startsWith("menuitem")) items.push(n);
    walk(n.props.children);
  };
  walk((tree as Node).props.children);
  return { html, root: tree as Node, items };
}

const plain: MenuItem[] = [
  { id: "a", title: "Alpha", kind: "action" },
  { id: "b", title: "Beta", kind: "action", description: "Its words." },
];

describe("a menu item with its own parts", () => {
  test("content draws in place of the title, with the item's style over its look, its marks, name and busy state", () => {
    const { html } = draw({
      label: "Dexterity rolls",
      sections: [{ key: "rows", items: [{ id: "save", title: "Save", kind: "action", content: createElement("span", { "data-row-words": "" }, "Save +2"), style: { borderColor: "red" }, data: { "data-proficiency": "prof" }, label: "Dexterity save +2, proficient", busy: true }] }],
      onPick() {},
    });
    assert.match(html, /<span data-row-words="">Save \+2<\/span>/);
    assert.doesNotMatch(html, />Save</, "the title itself is not drawn");
    assert.match(html, /role="menuitem"[^>]*aria-label="Dexterity save \+2, proficient"/);
    assert.match(html, /data-proficiency="prof"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /style="[^"]*border-color:red/);
  });

  test("items without them draw as before", () => {
    const { html } = draw({ label: "More", sections: [{ key: "s", items: plain }], onPick() {} });
    assert.doesNotMatch(html, /aria-label="(?!More)|aria-busy|data-proficiency/);
    assert.match(html, /<span style="[^"]*">Alpha<\/span>/);
    assert.match(html, /<span id="[^"]+" hidden="">Its words\.<\/span>/);
  });

  test("an item's events go on it, and its click stays Menu's one pick, even where events carry an onClick", () => {
    const picks: string[] = [];
    const closes: string[] = [];
    const pressed: string[] = [];
    const events = { onPointerDown: () => pressed.push("down"), onContextMenu: () => pressed.push("context"), onClick: () => pressed.push("own click") };
    const { items } = draw({ label: "Rolls", sections: [{ key: "s", items: [{ id: "x", title: "Check", kind: "action", events: events as never }] }], onPick: (id) => picks.push(id) }, closes);
    const item = items[0]!;
    (item.props.onPointerDown as () => void)();
    (item.props.onContextMenu as () => void)();
    (item.props.onClick as (e: unknown) => void)({ detail: 1 });
    assert.deepEqual(pressed, ["down", "context"], "the binding's own onClick never lands on the item");
    assert.deepEqual(picks, ["x"]);
    assert.deepEqual(closes, ["pick"]);
  });

  test("a disabled or busy item picks nothing", () => {
    const picks: string[] = [];
    const { items } = draw({ label: "Rolls", sections: [{ key: "s", items: [{ id: "x", title: "Check", kind: "action", disabled: true }, { id: "y", title: "Save", kind: "action", busy: true }] }], onPick: (id) => picks.push(id) });
    for (const item of items) (item.props.onClick as (e: unknown) => void)({ detail: 1 });
    assert.deepEqual(picks, []);
  });

  test("an item that is off draws its note dim with its title, and one that is on keeps its note muted", () => {
    const { html } = draw({ label: "More", sections: [{ key: "s", items: [{ id: "q", title: "Add to queue", kind: "action", disabled: true, note: "In the queue" }, { id: "t", title: "Fog", kind: "action", note: "on top" }] }], onPick() {} });
    const noteColor = (note: string) => new RegExp(`<span aria-hidden="true" style="[^"]*color:([^;"]+)[^"]*">${note}</span>`).exec(html)?.[1];
    assert.equal(noteColor("In the queue"), theme.color.textDisabled);
    assert.equal(noteColor("on top"), theme.color.textMuted);
  });

  test("typeahead reads the title, not the content drawn, and a key the item used never reaches Menu's own handling", () => {
    const previous = { document: globalThis.document };
    const focused: string[] = [];
    const nodes = new Map<string, { focus(): void; closest(): null }>();
    const doc = { activeElement: null as unknown };
    Object.assign(globalThis, { document: doc });
    try {
      const picks: string[] = [];
      const items: MenuItem[] = [
        { id: "check", title: "Check", kind: "action", content: "Zzz +2" },
        { id: "stealth", title: "Stealth", kind: "action", content: "Aaa +6" },
      ];
      const drawn = draw({ label: "Rolls", sections: [{ key: "s", items }], onPick: (id) => picks.push(id) });
      for (const [i, item] of drawn.items.entries()) {
        const id = items[i]!.id;
        const node = { focus: () => focused.push(id), closest: () => null };
        nodes.set(id, node);
        (item.props.ref as (n: unknown) => void)(node);
      }
      doc.activeElement = nodes.get("check");
      const key = (over: Record<string, unknown>) => ({ key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, timeStamp: 1, preventDefault() {}, ...over });
      (drawn.root.props.onKeyDown as (e: unknown) => void)(key({ key: "s", code: "KeyS" }));
      assert.deepEqual(focused, ["stealth"], "S finds Stealth by its title");
      (drawn.root.props.onKeyDown as (e: unknown) => void)(key({ key: "Enter", defaultPrevented: true }));
      assert.deepEqual(picks, [], "a key the row marked used, as its ContextMenu, is left alone");
      (drawn.root.props.onKeyDown as (e: unknown) => void)(key({ key: "Enter" }));
      assert.deepEqual(picks, ["check"]);
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});

describe("a pick that keeps the menu open (designs/qol/chips.md 4.1)", () => {
  test("a pick answering stay closes nothing, and another pick of the same menu still closes it", () => {
    const picks: string[] = [];
    const closes: string[] = [];
    const { items } = draw(
      {
        label: "DM",
        sections: [{ key: "s", items: [{ id: "move", title: "Move players here", kind: "action" }, { id: "follow", title: "Follow me", kind: "checkbox" }] }],
        onPick: (id) => {
          picks.push(id);
          return id === "move" ? "stay" : undefined;
        },
      },
      closes,
    );
    (items[0]!.props.onClick as (e: unknown) => void)({ detail: 1 });
    assert.deepEqual(closes, [], "the warned move keeps its menu open");
    (items[1]!.props.onClick as (e: unknown) => void)({ detail: 1 });
    assert.deepEqual(picks, ["move", "follow"]);
    assert.deepEqual(closes, ["pick"]);
  });

  test("Enter on an item whose pick stays keeps the menu open too", () => {
    withFocus((focusOn) => {
      const closes: string[] = [];
      const drawn = draw({ label: "Blackout", sections: [{ key: "s", items: [{ id: "reveal", title: "Show players Crypt", kind: "action" }] }], onPick: () => "stay" }, closes);
      focusOn(drawn, ["reveal"], "reveal");
      (drawn.root.props.onKeyDown as (e: unknown) => void)(key({ key: "Enter" }));
      assert.deepEqual(closes, []);
    });
  });

  test("focus moves to the target only when it changes, so the menu's keys keep their place while it stands", () => {
    assert.equal(focusMove(null, null), null);
    assert.equal(focusMove(null, "reveal:anyway"), "reveal:anyway", "a warned move arms its anyway item, which takes focus");
    assert.equal(focusMove("reveal:anyway", "reveal:anyway"), null, "a render while armed leaves focus where the keys put it");
    assert.equal(focusMove("reveal:anyway", "reveal"), "reveal", "Cancel puts the item back with focus on it");
    assert.equal(focusMove("reveal", null), null);
  });
});

describe("where a key opening lands", () => {
  const items: MenuItem[] = [
    { id: "show", title: "Show a handout…", kind: "action" },
    { id: "day", title: "Day", kind: "radio", checked: true },
    { id: "night", title: "Night", kind: "radio" },
    { id: "pat", title: "View as Pat", kind: "action" },
  ];

  test("a menu of actions with a choice partway down opens at its first item, or its last for Up", () => {
    assert.equal(openingAt(items, "first", { atEdge: true }), 0);
    assert.equal(openingAt(items, "last", { atEdge: true }), 3);
    assert.equal(openingAt([], "first", { atEdge: true }), -1);
  });

  test("any other menu still opens at its checked choice", () => {
    assert.equal(openingAt(items, "first"), 1);
    assert.equal(openingAt(items, "last"), 1);
  });
});

describe("the pick's input kind (D-261101-098)", () => {
  test("a click with detail 1 is a pointer's pick, and one with detail 0, a reader's activation, is a key's", () => {
    const picks: string[] = [];
    const { items } = draw({ label: "Rolls", sections: [{ key: "s", items: [{ id: "x", title: "Check", kind: "action" }] }], onPick: (id, by) => picks.push(`${id}:${by}`) });
    (items[0]!.props.onClick as (e: unknown) => void)({ detail: 1 });
    (items[0]!.props.onClick as (e: unknown) => void)({ detail: 0 });
    (items[0]!.props.onClick as (e: unknown) => void)({ detail: 2 });
    assert.deepEqual(picks, ["x:pointer", "x:key", "x:pointer"]);
  });

  test("Enter and Space pick as a key", () => {
    const previous = { document: globalThis.document };
    const doc = { activeElement: null as unknown };
    Object.assign(globalThis, { document: doc });
    try {
      const picks: string[] = [];
      const drawn = draw({ label: "Rolls", sections: [{ key: "s", items: [{ id: "check", title: "Check", kind: "action" }] }], onPick: (id, by) => picks.push(`${id}:${by}`) });
      const node = { focus() {}, closest: () => null };
      (drawn.items[0]!.props.ref as (n: unknown) => void)(node);
      doc.activeElement = node;
      const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, timeStamp: 1, preventDefault() {} });
      (drawn.root.props.onKeyDown as (e: unknown) => void)(key("Enter"));
      (drawn.root.props.onKeyDown as (e: unknown) => void)(key(" "));
      assert.deepEqual(picks, ["check:key", "check:key"]);
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});

/** A keydown as Menu's root reads it. */
function key(over: Record<string, unknown>) {
  return { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, timeStamp: 1, preventDefault() {}, ...over };
}

/** Runs `body` with a stand-in document whose focus Menu's keys read, and gives each drawn item a node that records its focus. */
function withFocus(body: (focusOn: (drawn: ReturnType<typeof draw>, ids: readonly string[], at: string) => string[]) => void): void {
  const previous = { document: globalThis.document };
  const doc = { activeElement: null as unknown };
  Object.assign(globalThis, { document: doc });
  try {
    body((drawn, ids, at) => {
      const focused: string[] = [];
      for (const [i, item] of drawn.items.entries()) {
        const id = ids[i]!;
        const node = { focus: () => focused.push(id), closest: () => null };
        (item.props.ref as (n: unknown) => void)(node);
        if (id === at) doc.activeElement = node;
      }
      return focused;
    });
  } finally {
    Object.assign(globalThis, previous);
  }
}

/*
 * A roll menu open on a page that goes held, such as the group save page
 * as its connection drops (D-261101-314). Its rows are divs, which the
 * page's disabled fieldset never stops, so Menu holds them itself.
 */
describe("a menu inside a held group", () => {
  const rows: MenuItem[] = [
    { id: "check", title: "Check", kind: "action" },
    { id: "save", title: "Save", kind: "action" },
    { id: "stealth", title: "Stealth", kind: "action" },
  ];

  test("draws every row disabled and says so, and stays open", () => {
    const free = draw({ label: "Rolls", sections: [{ key: "s", items: rows }], onPick() {} });
    const held = draw({ label: "Rolls", sections: [{ key: "s", items: rows }], onPick() {} }, [], { held: true });
    assert.doesNotMatch(free.html, /aria-disabled/);
    assert.equal(held.html.match(/role="menuitem"[^>]*aria-disabled="true"/g)?.length, 3);
    for (const row of held.items) assert.equal((row.props.style as { color?: string }).color, theme.color.textDisabled);
  });

  test("a pointer's pick and a reader's activation pick nothing and close nothing", () => {
    const picks: string[] = [];
    const closes: string[] = [];
    const { items } = draw({ label: "Rolls", sections: [{ key: "s", items: rows }], onPick: (id) => picks.push(id) }, closes, { held: true });
    for (const item of items) {
      (item.props.onPointerDown as ((e: unknown) => void) | undefined)?.({});
      (item.props.onClick as (e: unknown) => void)({ detail: 1 });
      (item.props.onClick as (e: unknown) => void)({ detail: 0 });
    }
    assert.deepEqual(picks, []);
    assert.deepEqual(closes, []);
  });

  test("Enter, Space and typeahead pick nothing, and the arrows still move through the held rows", () => {
    withFocus((focusOn) => {
      const picks: string[] = [];
      const drawn = draw({ label: "Rolls", sections: [{ key: "s", items: rows }], onPick: (id) => picks.push(id) }, [], { held: true });
      const focused = focusOn(drawn, rows.map((r) => r.id), "check");
      const keyDown = drawn.root.props.onKeyDown as (e: unknown) => void;
      keyDown(key({ key: "Enter" }));
      keyDown(key({ key: " " }));
      keyDown(key({ key: "s", code: "KeyS" }));
      keyDown(key({ key: "ArrowDown" }));
      assert.deepEqual(picks, []);
      // Enter and Space keep focus on Check, S finds Save, Down moves to Save from Check.
      assert.deepEqual(focused, ["check", "check", "save", "save"]);
    });
  });

  test("a held row drops its press binding, so a ContextMenu, a long press and a touch roll nothing", () => {
    const pressed: string[] = [];
    const events = {
      onPointerDown: () => pressed.push("down"),
      onTouchStart: () => pressed.push("touch"),
      onContextMenu: () => pressed.push("context"),
      onKeyDown: () => pressed.push("key"),
    };
    const picks: string[] = [];
    const { items } = draw({ label: "Rolls", sections: [{ key: "s", items: [{ id: "x", title: "Check", kind: "action", events }] }], onPick: (id) => picks.push(id) }, [], { held: true });
    const row = items[0]!.props as Record<string, ((e: unknown) => void) | undefined>;
    // The long press starts at the binding's pointer down, and a phone's long press arrives as a contextmenu.
    row.onPointerDown?.({ button: 0, pointerId: 1, pointerType: "touch" });
    row.onTouchStart?.({ changedTouches: [] });
    row.onContextMenu?.({ preventDefault() {} });
    row.onKeyDown?.({ key: "F10", shiftKey: true });
    row.onClick?.({ detail: 1 });
    assert.deepEqual(pressed, []);
    assert.deepEqual(picks, []);
  });
});

/*
 * A roll menu with no room on either side of its button slides back over
 * it (popoverPlace's `covers`), so a fast second tap aimed at the button
 * lands on a row. A press that starts within 350 ms of the menu's opening
 * is ignored (D-261101-313). The clock is a stand-in.
 */
describe("a menu that covers its anchor", () => {
  const rows: MenuItem[] = [{ id: "adv", title: "Roll with Advantage", kind: "action" }];
  const covering = { left: 0, top: 270, width: 300, height: 287, scrolls: false, rose: false, covers: true };
  const beside = { left: 0, top: 270, width: 300, height: 287, scrolls: false, rose: false };

  function opened(t: { mock: { method(o: object, name: string, fn: () => number): unknown } }, placed: Record<string, unknown>, events?: MenuItem["events"]) {
    const clock = { now: 1000 };
    t.mock.method(performance, "now", () => clock.now);
    const picks: string[] = [];
    const closes: string[] = [];
    const drawn = draw({ label: "Roll options", sections: [{ key: "s", items: rows.map((r) => ({ ...r, events })) }], onPick: (id, by) => picks.push(`${id}:${by}`) }, closes, { placed });
    const row = drawn.items[0]!.props as Record<string, (e: unknown) => void>;
    const press = (at: number) => {
      clock.now = at;
      row.onPointerDown!({ button: 0 });
      row.onClick!({ detail: 1 });
    };
    return { drawn, row, press, picks, closes, clock };
  }

  test("a press within 350 ms of its opening neither picks nor closes, and one after it picks", (t) => {
    const menu = opened(t, covering);
    menu.press(1100);
    menu.press(1349);
    assert.deepEqual(menu.picks, []);
    assert.deepEqual(menu.closes, []);
    menu.press(1400);
    assert.deepEqual(menu.picks, ["adv:pointer"]);
    assert.deepEqual(menu.closes, ["pick"]);
  });

  test("the press it ignores never starts the row's press binding", (t) => {
    const pressed: string[] = [];
    const menu = opened(t, covering, { onPointerDown: () => pressed.push("down") });
    menu.press(1100);
    assert.deepEqual(pressed, []);
    menu.press(1400);
    assert.deepEqual(pressed, ["down"]);
  });

  test("a key and a reader's activation pick at once", (t) => {
    withFocus((focusOn) => {
      const menu = opened(t, covering);
      focusOn(menu.drawn, ["adv"], "adv");
      menu.clock.now = 1050;
      (menu.drawn.root.props.onKeyDown as (e: unknown) => void)(key({ key: "Enter" }));
      menu.row.onPointerDown!({ button: 0 });
      menu.row.onClick!({ detail: 0 });
      assert.deepEqual(menu.picks, ["adv:key", "adv:key"]);
    });
  });

  test("a menu that stands beside its anchor picks at once, as before", (t) => {
    const menu = opened(t, beside);
    menu.press(1050);
    assert.deepEqual(menu.picks, ["adv:pointer"]);
  });
});
