import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * End turn while its op waits for the server (P3-ASTRA-02, P3R-5). Its
 * spinner beside the words widened the pill past the room the band gave it
 * (band.ts bandFit), off the screen at 320 px at 130% stacked and at 360 px
 * at 115% on one line. The spinner now stands over the words, which stay
 * unseen, so the pill keeps its width and the button its name.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { EndTurnPill } = await import("./parts.tsx");

function render(props: { waiting: boolean; stack?: boolean }): string {
  return renderToStaticMarkup(createElement(EndTurnPill, { ...props, onClick() {} }));
}

/** What the pill holds side by side: the markup inside its one span, at its top level. */
function pillItems(markup: string): string[] {
  const inner = /^<button[^>]*><span[^>]*>(.*)<\/span><\/button>$/.exec(markup)?.[1] ?? "";
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of inner.matchAll(/<(\/?)(span|svg)\b[^>]*>|[^<]+/g)) {
    const tag = m[2];
    if (tag && m[1] === "/") depth--;
    else if (tag) depth++;
    if (depth === 0) {
      items.push(inner.slice(start, m.index + m[0].length));
      start = m.index + m[0].length;
    }
  }
  return items;
}

for (const stack of [true, false]) {
  const lines = stack ? "stacked" : "on one line";
  test(`${lines} and waiting, the spinner stands over the words, so the pill holds one item and keeps its width (P3-ASTRA-02, P3R-5)`, () => {
    const markup = render({ waiting: true, stack });
    const items = pillItems(markup);
    assert.equal(items.length, 1, `the pill holds ${items.length} items side by side`);
    assert.match(markup, /<span style="opacity:0[^"]*">End turn<\/span>/, "the words stay, unseen");
    assert.match(markup, /<span style="position:absolute;inset:0;[^"]*"><svg[^>]*aria-label="Ending your turn"/, "the spinner stands over them");
    assert.match(markup, /aria-busy="true"/);
    assert.ok(markup.indexOf("Ending your turn") < markup.indexOf(">End turn<"), "the spinner comes first, so the button's name reads the same either way");
  });

  test(`${lines} and idle, the words show and nothing spins`, () => {
    const markup = render({ waiting: false, stack });
    assert.match(markup, /<span style="opacity:1[^"]*">End turn<\/span>/);
    assert.doesNotMatch(markup, /Ending your turn/);
  });
}

test("stacked, the words wrap onto two lines", () => {
  assert.match(render({ waiting: false, stack: true }), /<span style="opacity:1;width:min-content;white-space:normal[^"]*">End turn<\/span>/);
  assert.doesNotMatch(render({ waiting: false }), /min-content/);
});

/*
 * The phone band's End turn and the DM's Next draw a 26 px pill inside a
 * 44 px target that stands past the band's foot. A ring on the target fell
 * on the map, where the light theme's ring read 2.67:1 over a dark board
 * (lighttheme lt-3), so the ring goes on the pill as in a header row.
 */
const { NextPill } = await import("./parts.tsx");
for (const [name, markup] of [
  ["End turn", render({ waiting: false })],
  ["Next", renderToStaticMarkup(createElement(NextPill, { busy: false, spinner: false, start: false, onClick() {} }))],
] as const) {
  test(`${name}'s focus ring goes on its pill, not its larger target`, () => {
    assert.match(markup, /^<button[^>]* data-pill-focus=""[^>]*><span data-pill=""/);
    assert.equal(markup.match(/data-pill=""/g)?.length, 1, "one pill takes the ring");
  });
}

/*
 * The DM's Next while a turn change waits for its answer: busy from the
 * moment it is sent, its spinner only after the shared delay, and, as the
 * house busy button, enabled so it keeps its focus, with a tap doing
 * nothing (D-261110-361).
 */
type Pill = { busy: boolean; spinner: boolean; disabled?: boolean };

/** The pill's button as drawn, and how many taps on it reached its handler. */
function nextPill(props: Pill): { markup: string; tap(): number } {
  let taps = 0;
  let button: { props: { onClick(): void } } | undefined;
  function Probe() {
    button = NextPill({ ...props, start: false, onClick: () => void taps++ }) as unknown as { props: { onClick(): void } };
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return {
    markup: renderToStaticMarkup(createElement(NextPill, { ...props, start: false, onClick() {} })),
    tap: () => {
      button!.props.onClick();
      return taps;
    },
  };
}

test("the DM's Next is busy at once while a turn change waits, enabled and deaf to a tap, its spinner shown only once the wait shows", () => {
  const waits = nextPill({ busy: true, spinner: false });
  assert.match(waits.markup, /aria-busy="true"/);
  assert.doesNotMatch(waits.markup, /<button[^>]* disabled=""/, "it stays enabled, so it keeps its focus");
  assert.doesNotMatch(waits.markup, /Moving to the next turn/, "no spinner before the delay");
  assert.equal(waits.tap(), 0, "a tap while it waits does nothing");
  const shown = nextPill({ busy: true, spinner: true });
  assert.match(shown.markup, /aria-label="Moving to the next turn"/);
  assert.doesNotMatch(shown.markup, /<button[^>]* disabled=""/);
  assert.equal(shown.tap(), 0);
  const idle = nextPill({ busy: false, spinner: false });
  assert.doesNotMatch(idle.markup, /aria-busy/);
  assert.equal(idle.tap(), 1, "a tap when idle sends");
  assert.match(nextPill({ busy: false, spinner: false, disabled: true }).markup, /<button[^>]* disabled=""/, "an empty fight's Start is off");
});
