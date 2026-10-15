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
