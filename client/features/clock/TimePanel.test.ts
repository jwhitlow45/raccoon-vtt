import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { room } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";

/*
 * The Time panel drawn to markup (docs/design/design-v1-calendar.md 4,
 * docs/design/design-v1-sound-layout.md 3 and 7): the DM's start form with no
 * clock, the date and the controls with one, the five step buttons of one
 * size, and a player's date or the line that says the DM isn't sharing it.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { default: TimePanel, NOT_SHARING } = await import("./TimePanel.tsx");

(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const CLOCK: NonNullable<RoomState["clock"]> = { id: "c1", rev: 1, t: 3 * 86_400 + 20 * 3_600, shown: true, calendar: { kind: "days" } };

function draw(role: "dm" | "player", clock: RoomState["clock"] | null): string {
  const view = { ...room(), clock: clock ?? undefined } as RoomState;
  const store = createStore(() => ({
    view,
    you: { memberId: role === "dm" ? "dm1" : "p1", role },
    roomId: "r1",
    sceneId: "s1",
    connection: "open",
    pending: [],
    online: [],
    serverOffset: 0,
    local: { selectedIds: [], multi: false },
  }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: new RoomScope(),
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: { notify: () => {}, openPanel: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(TimePanel, {} as never),
      }),
    }),
  );
}

/** Every button in the steps group, by its words, with the style it draws. */
function steps(html: string): { words: string; style: string; expanded: string | null }[] {
  const group = /<div role="group" aria-labelledby="[^"]+"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  return [...group.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    words: m[2]!.replace(/<[^>]+>/g, ""),
    style: /style="([^"]*)"/.exec(m[1]!)?.[1] ?? "",
    expanded: /aria-expanded="(true|false)"/.exec(m[1]!)?.[1] ?? null,
  }));
}

describe("the DM's Time", () => {
  test("no clock: the start form, and no date", () => {
    const html = draw("dm", null);
    assert.match(html, />Start the clock</);
    assert.doesNotMatch(html, /data-clock-date/);
  });

  test("a clock: the date and time, Move the clock on, Sharing, Calendar and Stop, each heading a level under the panel's", () => {
    const html = draw("dm", CLOCK);
    assert.match(html, /data-clock-date=""[^>]*>Day 4</);
    const headings = [...html.matchAll(/<h(\d)[^>]*>([^<]*)<\/h\1>/g)].map((m) => `h${m[1]} ${m[2]}`);
    assert.deepEqual(headings, ["h3 Move the clock on", "h3 Sharing", "h3 Stop"], "no h4 left from Ambiance's Time group");
  });

  test("the five step buttons are one size in one grid, Other amount… across its own row (D-261106-095)", () => {
    const buttons = steps(draw("dm", CLOCK));
    assert.deepEqual(
      buttons.map((b) => b.words),
      ["10 minutes", "1 hour", "8 hours", "To dawn", "Other amount…"],
    );
    const size = (style: string) => /font-size:[^;]+;padding:[^;]+/.exec(style)?.[0];
    assert.ok(size(buttons[0]!.style), "a step's size is read");
    for (const b of buttons) assert.equal(size(b.style), size(buttons[0]!.style), `${b.words} is the steps' size`);
    assert.match(buttons[4]!.style, /grid-column:1 \/ -1/);
    assert.equal(buttons[4]!.expanded, "false");
    for (const b of buttons.slice(0, 4)) assert.doesNotMatch(b.style, /grid-column/);
  });
});

describe("a player's Time", () => {
  test("with the clock shared: the date and time, and no controls", () => {
    const html = draw("player", CLOCK);
    assert.match(html, /data-clock-date=""[^>]*>Day 4</);
    assert.doesNotMatch(html, /Move the clock on|Start the clock|Stop the clock/);
  });

  test("left open after the DM stops sharing: it says so", () => {
    const html = draw("player", null);
    assert.equal(NOT_SHARING, "The DM isn't sharing the date and time now.");
    assert.match(html, /The DM isn&#x27;t sharing the date and time now\./);
  });
});
