import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../lib/theme.ts";

/*
 * The one wait line (design section 14.1), and its small form for a wait
 * inside help or an options line (docs/design-v1-design-pass.md 4.4). Static
 * markup runs no effects, so these render with `delay={0}`, which a caller
 * that has already waited passes and which shows from the first render.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Loading } = await import("./Loading.tsx");

const WORDS = "Working out who sees what…";

describe("Loading", () => {
  test("waits out the shared delay before it draws anything", () => {
    assert.equal(renderToStaticMarkup(createElement(Loading, { text: WORDS })), "");
    assert.equal(renderToStaticMarkup(createElement(Loading, { text: WORDS, small: true })), "");
  });

  test("with no delay, draws at once: a status div with the 18 px spinner and 14 px words", () => {
    const html = renderToStaticMarkup(createElement(Loading, { text: WORDS, delay: 0 }));
    assert.match(html, /^<div role="status"/);
    assert.match(html, new RegExp(`^<div[^>]*font-size:${theme.font.body14}px`));
    assert.match(html, /<svg[^>]*width="18"/);
    assert.ok(html.includes(WORDS));
  });

  test("small is a span with 13 px words and a 16 px spinner, and holds no div", () => {
    const html = renderToStaticMarkup(createElement(Loading, { text: WORDS, small: true, delay: 0 }));
    assert.match(html, /^<span role="status"/);
    assert.match(html, new RegExp(`^<span[^>]*display:inline-flex`));
    assert.match(html, new RegExp(`^<span[^>]*font-size:${theme.font.small}px`));
    assert.match(html, new RegExp(`<svg[^>]*width="${theme.icon.sm}"`));
    assert.equal(theme.font.small, 13);
    assert.equal(theme.icon.sm, 16);
    assert.doesNotMatch(html, /<div/);
    assert.ok(html.includes(WORDS));
  });

  test("small keeps its detail inside spans", () => {
    const html = renderToStaticMarkup(createElement(Loading, { text: WORDS, detail: "2 of 5", small: true, delay: 0 }));
    assert.ok(html.includes("2 of 5"));
    assert.doesNotMatch(html, /<div/);
  });

  test("with live false it has no role, in either size, for a caller whose line is already a live region", () => {
    const small = renderToStaticMarkup(createElement(Loading, { text: WORDS, small: true, live: false, delay: 0 }));
    assert.match(small, /^<span/);
    assert.doesNotMatch(small, /role=/);
    const full = renderToStaticMarkup(createElement(Loading, { text: WORDS, live: false, delay: 0 }));
    assert.match(full, /^<div/);
    assert.doesNotMatch(full, /role=/);
  });

  test("small fits inside a help line's p as phrasing content", () => {
    const html = renderToStaticMarkup(createElement("p", null, createElement("span", { role: "status" }, createElement(Loading, { text: WORDS, small: true, live: false, delay: 0 }))));
    assert.match(html, /^<p><span role="status"><span style="[^"]*"><svg/);
    assert.doesNotMatch(html, /<div/);
  });
});
