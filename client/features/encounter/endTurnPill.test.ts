import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * End turn while its op waits for the server (P3-ASTRA-02). Stacked on two
 * lines for a narrow band, its spinner beside the words widened the pill
 * past the room the band gave it (band.ts bandFit), off a 320 px screen at
 * 130%. Stacked, the spinner now stands over the words, which stay unseen,
 * so the pill keeps its width and the button its name.
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

test("stacked and waiting, the spinner stands over the words, so the pill holds one item and keeps its width", () => {
  const markup = render({ waiting: true, stack: true });
  const items = pillItems(markup);
  assert.equal(items.length, 1, `the pill holds ${items.length} items side by side`);
  assert.match(markup, /<span style="width:min-content;[^"]*opacity:0">End turn<\/span>/, "the words stay, unseen");
  assert.match(markup, /<span style="position:absolute;inset:0;[^"]*"><svg[^>]*aria-label="Ending your turn"/, "the spinner stands over them");
  assert.match(markup, /aria-busy="true"/);
  assert.ok(markup.indexOf("Ending your turn") < markup.indexOf(">End turn<"), "the spinner comes first, as on one line, so the button's name reads the same");
});

test("stacked and idle, the words show and nothing spins", () => {
  const markup = render({ waiting: false, stack: true });
  assert.match(markup, /opacity:1">End turn<\/span>/);
  assert.doesNotMatch(markup, /Ending your turn/);
});

test("on one line, the spinner still goes beside the words, where the band has room for it", () => {
  const items = pillItems(render({ waiting: true }));
  assert.equal(items.length, 2);
  assert.match(items[0]!, /aria-label="Ending your turn"/);
  assert.equal(items[1], "End turn");
});
