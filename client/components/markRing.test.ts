import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MARK_RING } from "../lib/memberColor.ts";
import { theme } from "../lib/theme.ts";
import { tokenPattern } from "./testing/tokenPattern.ts";

/*
 * A mark in a member's color keeps the member's own color and wears a 1 px
 * ring (docs/design/design-v1-light-theme.md 6.3), so a white or yellow dot
 * still shows its edge on a light page. The ring is an inset shadow, so no
 * box grows.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Swatches } = await import("./Swatches.tsx");
const { DotLabel, RowDot } = await import("./Row.tsx");

const ring = `box-shadow:inset 0 0 0 1px ${tokenPattern(theme.color.markRing)}`;

describe("the member mark ring", () => {
  test("is a 1 px inset shadow in markRing", () => {
    assert.equal(MARK_RING, `inset 0 0 0 1px ${theme.color.markRing}`);
  });

  test("a row dot keeps its color and wears the ring, at any size", () => {
    for (const size of [undefined, 12, 16]) {
      const markup = renderToStaticMarkup(createElement(RowDot, { color: "#ffffff", size }));
      assert.match(markup, /background:#ffffff/);
      assert.match(markup, new RegExp(ring));
      assert.doesNotMatch(markup, /border:/, "a border would grow the dot");
    }
  });

  test("a dot before a member's name wears it too", () => {
    assert.match(renderToStaticMarkup(createElement(DotLabel, { color: "#f7df00", children: "Dana" })), new RegExp(`background:#f7df00;${ring}`));
  });

  test("a swatch's disk and its badge keep their color and wear the ring, the disk with no border", () => {
    const markup = renderToStaticMarkup(createElement(Swatches, { label: "Color", value: "#ffffff", options: [{ color: "#ffffff", badge: "DM" }, "#f7df00"], onChange() {} }));
    const disks = [...markup.matchAll(/<span style="display:block;width:28px;height:28px[^"]*"/g)].map((m) => m[0]);
    assert.equal(disks.length, 2);
    for (const disk of disks) {
      assert.match(disk, new RegExp(ring));
      assert.doesNotMatch(disk, /;border:/);
    }
    const badge = /<span style="position:absolute;right[^"]*"/.exec(markup)?.[0] ?? "";
    assert.match(badge, /background:#ffffff/);
    assert.match(badge, new RegExp(ring));
  });
});
