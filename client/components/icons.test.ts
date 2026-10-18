import "./testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CREDITS, FEATHER_ICONS, FEATHER_NOTICE, LUCIDE_ICONS, LUCIDE_NOTICE } from "#shared/credits.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ICON_NAMES, Icon, LUCIDE } = await import("./Icon.tsx");

/** One icon, one meaning, and every copied icon credited (docs/design-v1-icons.md 2 and 6). */

// Meanings that share a drawing on purpose: the DM desk's Pass and Fail beside their words, as the check and the close they are.
const SHARED = new Set(["check|pass", "close|fail"]);

// The icons Lucide's license lists as derived from Feather (https://github.com/lucide-icons/lucide/blob/main/LICENSE, read 2026-10-18).
const FROM_FEATHER = new Set("airplay alert-circle alert-octagon alert-triangle aperture arrow-down-circle arrow-down-left arrow-down-right arrow-down arrow-left-circle arrow-left arrow-right-circle arrow-right arrow-up-circle arrow-up-left arrow-up-right arrow-up at-sign calendar cast check chevron-down chevron-left chevron-right chevron-up chevrons-down chevrons-left chevrons-right chevrons-up circle clipboard clock code columns command compass corner-down-left corner-down-right corner-left-down corner-left-up corner-right-down corner-right-up corner-up-left corner-up-right crosshair database divide-circle divide-square dollar-sign download external-link feather frown hash headphones help-circle info italic key layout life-buoy link-2 link loader lock log-in log-out maximize meh minimize minimize-2 minus-circle minus-square minus monitor moon more-horizontal more-vertical move music navigation-2 navigation octagon pause-circle percent plus-circle plus-square plus power radio rss search server share shopping-bag sidebar smartphone smile square table-2 tablet target terminal trash-2 trash triangle tv type upload x-circle x-octagon x-square x zoom-in zoom-out".split(" "));

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
    const listed = new Set([...section.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
    assert.deepEqual([...listed].sort(), [...LUCIDE_ICONS].sort(), "and CREDITS.md names no icon the app does not copy");
  });

  test("the ISC credit carries the license's whole notice, which it asks for in every copy", () => {
    const credit = CREDITS.find((g) => g.id === "interface-icons")!.credits[0]!;
    assert.equal(credit.license, "ISC");
    assert.ok(credit.changes?.includes(LUCIDE_NOTICE));
    for (const words of ["Cole Bemis", "Lucide Contributors", "Permission to use, copy, modify, and/or distribute", "THE SOFTWARE IS PROVIDED \"AS IS\""]) assert.ok(LUCIDE_NOTICE.includes(words), words);
  });

  test("the icons Lucide derives from Feather carry Feather's MIT notice too, on the About page and in CREDITS.md", () => {
    assert.deepEqual([...FEATHER_ICONS].sort(), LUCIDE_ICONS.filter((icon) => FROM_FEATHER.has(icon)).sort(), "every copied icon from Feather, and only those");
    const credit = CREDITS.find((g) => g.id === "interface-icons")!.credits[0]!;
    assert.ok(credit.changes?.endsWith(FEATHER_NOTICE));
    for (const icon of FEATHER_ICONS) assert.ok(credit.changes!.slice(credit.changes!.indexOf(LUCIDE_NOTICE) + LUCIDE_NOTICE.length).includes(icon), `the Feather notice names ${icon}`);
    for (const words of ["Copyright (c) 2013-present Cole Bemis", "Permission is hereby granted, free of charge", "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND"]) assert.ok(FEATHER_NOTICE.includes(words), words);
    const md = readFileSync(join(import.meta.dirname, "../../CREDITS.md"), "utf8");
    const section = md.slice(md.indexOf("## Interface icons"), md.indexOf("## Token icons"));
    const feather = section.slice(section.indexOf("derived from Feather"));
    for (const icon of FEATHER_ICONS) assert.ok(feather.includes(`\`${icon}\``), `CREDITS.md names ${icon} under Feather`);
    for (const line of ["Copyright (c) 2013-present Cole Bemis", "Permission is hereby granted, free of charge, to any person obtaining a copy", "SOFTWARE."]) assert.ok(feather.includes(line), line);
  });
});
