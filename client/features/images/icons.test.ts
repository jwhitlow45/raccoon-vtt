import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { GAME_ICONS_DIR } from "#shared/gameIcons.ts";
import {
  DEFAULT_ICON_COLOR,
  ICON_COLORS,
  glyphColor,
  iconCredit,
  iconPathData,
  iconTitle,
  iconUrl,
  imageFace,
  loadGlyph,
  parseIconIndex,
  resetGlyphsForTest,
  searchIcons,
  type IconCatalog,
} from "./icons.ts";

const SHIPPED = readFileSync(new URL(`../../../public${GAME_ICONS_DIR}/index.json`, import.meta.url), "utf8");

const small: IconCatalog = parseIconIndex({
  commit: "x",
  authors: [
    { id: "lorc", icons: ["goblin-head", "skull-crossed-bones", "dragon-head", "wolf-head", "bat"] },
    { id: "delapouite", icons: ["goblin", "dragon-breath", "bat", "skull-shield"] },
    { id: "skoll", icons: ["bat"] },
  ],
});
const keys = (q: string, catalog = small) => searchIcons(catalog, q).map((e) => e.key);

describe("icon index", () => {
  test("the shipped index reads whole: every icon, each with a credit", () => {
    const catalog = parseIconIndex(JSON.parse(SHIPPED));
    assert.equal(catalog.entries.length, 4180);
    for (const entry of catalog.entries) assert.ok(iconCredit(entry.key), entry.key);
    assert.equal(catalog.byKey.get("lorc/wolf-head")?.title, "Wolf head");
  });

  test("leaves out what is not a key, and an author the credits do not know", () => {
    const catalog = parseIconIndex({
      authors: [
        { id: "lorc", icons: ["ok-name", "Bad Name", "../../etc", 7] },
        { id: "someone-new", icons: ["axe"] },
        { id: "../x", icons: ["y"] },
        null,
      ],
    });
    assert.deepEqual(catalog.entries.map((e) => e.key), ["lorc/ok-name"]);
    assert.throws(() => parseIconIndex({ nope: true }));
    assert.throws(() => parseIconIndex(null));
  });

  test("a title from the name", () => {
    assert.equal(iconTitle("wolf-head"), "Wolf head");
    assert.equal(iconTitle("bat"), "Bat");
  });
});

describe("icon search", () => {
  test("words of the name, best match first, shorter names before longer", () => {
    assert.deepEqual(keys("goblin"), ["delapouite/goblin", "lorc/goblin-head"]);
    assert.deepEqual(keys("dragon head"), ["lorc/dragon-head"]);
    assert.deepEqual(keys("drag"), ["delapouite/dragon-breath", "lorc/dragon-head"]);
  });

  test("the author narrows it", () => {
    assert.deepEqual(keys("skull lorc"), ["lorc/skull-crossed-bones"]);
    assert.deepEqual(keys("bat skoll"), ["skoll/bat"]);
    assert.deepEqual(keys("bat"), ["delapouite/bat", "lorc/bat", "skoll/bat"]);
    assert.deepEqual(keys("bat delapouite"), ["delapouite/bat"]);
  });

  test("a plural finds its singular, and three letters inside a name match", () => {
    assert.deepEqual(keys("goblins"), ["delapouite/goblin", "lorc/goblin-head"]);
    assert.deepEqual(keys("ragon"), ["delapouite/dragon-breath", "lorc/dragon-head"]);
    assert.deepEqual(keys("ra"), []);
  });

  test("case and punctuation do not matter, and nothing typed lists all by title", () => {
    assert.deepEqual(keys("WOLF-Head!"), ["lorc/wolf-head"]);
    assert.equal(keys("").length, 10);
    assert.deepEqual(keys("  ").slice(0, 3), ["delapouite/bat", "lorc/bat", "skoll/bat"]);
  });

  test("finds what a table asks for in the shipped set", () => {
    const catalog = parseIconIndex(JSON.parse(SHIPPED));
    assert.ok(keys("goblin", catalog).length > 0);
    assert.equal(keys("wolf head lorc", catalog)[0], "lorc/wolf-head");
    assert.ok(keys("skull lorc", catalog).every((k) => k.startsWith("lorc/")));
  });

  test("a search over the whole set is quick enough for every keystroke", () => {
    const catalog = parseIconIndex(JSON.parse(SHIPPED));
    const start = performance.now();
    for (const q of ["g", "go", "gob", "gobl", "gobli", "goblin", "dragon head", "skull lorc"]) searchIcons(catalog, q);
    assert.ok(performance.now() - start < 400);
  });
});

describe("icon files and credits", () => {
  test("a key becomes its file's URL under the pinned folder, anything else none", () => {
    assert.equal(iconUrl("lorc/wolf-head"), `${GAME_ICONS_DIR}/lorc/wolf-head.svg`);
    assert.equal(iconUrl("../secret/x"), null);
    assert.equal(iconUrl("lorc/wolf-head.svg"), null);
  });

  test("the credit reads as the design words it", () => {
    assert.equal(iconCredit("lorc/wolf-head")?.text, "Wolf head by Lorc, CC BY 3.0");
    assert.equal(iconCredit("zeromancer/heart-0")?.text, "Heart 0 by Zeromancer, CC0 1.0");
    assert.equal(iconCredit("nobody/axe"), null);
  });

  test("reads the one path of a shipped file and refuses anything else", () => {
    const file = readFileSync(new URL(`../../../public${GAME_ICONS_DIR}/lorc/wolf-head.svg`, import.meta.url), "utf8");
    assert.match(iconPathData(file) ?? "", /^M179\.3 38\.94C/);
    assert.equal(iconPathData("<!doctype html><title>RaccoonVTT</title>"), null);
    assert.equal(iconPathData('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="M1 1z"/><script/></svg>'), null);
    assert.equal(iconPathData('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="M1 1z&lt;"/></svg>'), null);
  });
});

describe("icon disk", () => {
  test("the member palette and four neutrals, the default among them", () => {
    assert.equal(ICON_COLORS.length, 14);
    assert.equal(new Set(ICON_COLORS.map((c) => c.toLowerCase())).size, 14);
    assert.ok(ICON_COLORS.includes(DEFAULT_ICON_COLOR));
  });

  test("the glyph takes white or near-black, whichever contrasts more", () => {
    assert.equal(glyphColor("#0b0b0e"), "#ffffff");
    assert.equal(glyphColor("#2a2a32"), "#ffffff");
    assert.equal(glyphColor("#3e8ef7"), "#16161a");
    assert.equal(glyphColor("#f7df00"), "#16161a");
    assert.equal(glyphColor("#e5e5e5"), "#16161a");
    assert.equal(glyphColor("#8e4ec6"), "#ffffff");
    assert.equal(glyphColor("not a color"), "#ffffff");
    for (const color of ICON_COLORS) assert.ok(contrast(color, glyphColor(color)) >= 4.5, color);
  });
});

function contrast(a: string, b: string): number {
  const l = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [hi, lo] = [l(a), l(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("icon files on a device", () => {
  const realFetch = globalThis.fetch;
  const file = readFileSync(new URL(`../../../public${GAME_ICONS_DIR}/lorc/wolf-head.svg`, import.meta.url), "utf8");

  test("offline, a pick draws initials, and once the file arrives, the glyph", async () => {
    resetGlyphsForTest();
    let online = false;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (!online) throw new TypeError("Failed to fetch");
      return new Response(file, { status: 200, headers: { "content-type": "image/svg+xml" } });
    }) as typeof fetch;
    try {
      const icon = { icon: "lorc/wolf-head", color: "#2a2a32" };
      await assert.rejects(loadGlyph("lorc/wolf-head"));
      assert.equal(imageFace(icon, false, { status: "offline" }), "initials");
      // A failure is not remembered: back online, the next ask fetches it.
      online = true;
      const glyph = await loadGlyph("lorc/wolf-head");
      assert.ok(typeof glyph === "object");
      assert.equal(imageFace(icon, false, { status: "ready", d: glyph.d }), "glyph");
      // Fetched once, then kept for the page.
      await loadGlyph("lorc/wolf-head");
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a key the server has no file for is missing for good, and so is a page in its place", async () => {
    resetGlyphsForTest();
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      return String(url).includes("no-such") ? new Response("{}", { status: 404 }) : new Response("<!doctype html>", { status: 200 });
    }) as typeof fetch;
    try {
      assert.equal(await loadGlyph("lorc/no-such-icon"), "missing");
      assert.equal(await loadGlyph("lorc/no-such-icon"), "missing");
      assert.equal(await loadGlyph("lorc/also-unknown"), "missing");
      assert.equal(calls, 2);
      assert.equal(await loadGlyph("../../etc"), "missing");
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an upload shows once decoded, an icon once its glyph is here, and nothing shows initials", () => {
    const upload = { assetId: "a", crop: { cx: 0.5, cy: 0.5, zoom: 1 } };
    assert.equal(imageFace(upload, true, { status: "missing" }), "upload");
    assert.equal(imageFace(upload, false, { status: "missing" }), "initials");
    assert.equal(imageFace({ icon: "lorc/bat", color: "#000000" }, true, { status: "loading" }), "initials");
    assert.equal(imageFace({ icon: "lorc/bat", color: "#000000" }, false, { status: "missing" }), "initials");
    assert.equal(imageFace(undefined, false, { status: "missing" }), "initials");
  });
});
