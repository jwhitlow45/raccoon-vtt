import "./testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CREDITS, LUCIDE_ICONS, LUCIDE_NOTICE } from "#shared/credits.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ICON_NAMES, Icon, LUCIDE } = await import("./Icon.tsx");

/** One icon, one meaning, and every copied icon credited (docs/design-v1-icons.md 2 and 6). */

// Meanings that share a drawing on purpose: the DM desk's Pass and Fail beside their words, as the check and the close they are.
const SHARED = new Set(["check|pass", "close|fail"]);

describe("the interface icons", () => {
  test("each meaning draws a shape no other meaning draws, except the listed pairs", () => {
    const seen = new Map<string, string>();
    for (const name of ICON_NAMES) {
      const markup = renderToStaticMarkup(createElement(Icon, { name }));
      const other = seen.get(markup);
      if (other) assert.ok(SHARED.has([other, name].sort().join("|")), `${name} draws what ${other} draws: one drawing, one meaning`);
      else seen.set(markup, name);
    }
  });

  test("the Lucide icons copied are exactly the ones the credit and CREDITS.md name", () => {
    assert.deepEqual([...new Set(Object.values(LUCIDE))].sort(), [...LUCIDE_ICONS].sort());
    for (const name of Object.keys(LUCIDE)) assert.ok((ICON_NAMES as string[]).includes(name), `${name} is an icon`);
    const credit = CREDITS.find((g) => g.id === "interface-icons")!.credits[0]!;
    const md = readFileSync(join(import.meta.dirname, "../../CREDITS.md"), "utf8");
    const section = md.slice(md.indexOf("## Interface icons"), md.indexOf("## Token icons"));
    for (const icon of LUCIDE_ICONS) {
      assert.ok(credit.changes?.includes(icon), `the About page's credit names ${icon}`);
      assert.ok(section.includes(`\`${icon}\``), `CREDITS.md names ${icon}`);
    }
    const listed = [...section.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), [...LUCIDE_ICONS].sort(), "and CREDITS.md names no icon the app does not copy");
  });

  test("the ISC credit carries the license's whole notice, which it asks for in every copy", () => {
    const credit = CREDITS.find((g) => g.id === "interface-icons")!.credits[0]!;
    assert.equal(credit.license, "ISC");
    assert.ok(credit.changes?.endsWith(LUCIDE_NOTICE));
    for (const words of ["Cole Bemis", "Lucide Contributors", "Permission to use, copy, modify, and/or distribute", "THE SOFTWARE IS PROVIDED \"AS IS\""]) assert.ok(LUCIDE_NOTICE.includes(words), words);
  });
});
