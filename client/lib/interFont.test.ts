import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { describe, test } from "node:test";
import { CREDITS } from "#shared/credits.ts";
import { INTER_FAMILY, INTER_FILES, INTER_UNICODE_RANGE, INTER_VERSION } from "./interFont.ts";
import { theme } from "./theme.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Each @font-face rule in globals.css, as its descriptors. */
function fontFaces(css: string): Record<string, string>[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) =>
    Object.fromEntries(
      m[1]!
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
    ),
  );
}

describe("the interface font", () => {
  const faces = fontFaces(read("client/globals.css"));

  test("globals.css has a roman and an italic face of Inter, each the subset scripts/inter.ts keeps, swapping in when it loads", () => {
    assert.deepEqual(faces.map((f) => f["font-style"]).sort(), ["italic", "normal"]);
    for (const face of faces) {
      const file = face["font-style"] === "italic" ? INTER_FILES.italic : INTER_FILES.roman;
      assert.equal(face["font-family"], INTER_FAMILY);
      assert.equal(face["font-weight"], "100 900");
      assert.equal(face["font-display"], "swap");
      assert.equal(face.src, `url("${file}") format("woff2")`);
      assert.equal(face["unicode-range"], INTER_UNICODE_RANGE.join(", "));
    }
  });

  test("both files ship in public/, the roman within its 120 KB budget, with Inter's license beside them", () => {
    const roman = statSync(new URL(`public${INTER_FILES.roman}`, root)).size;
    const italic = statSync(new URL(`public${INTER_FILES.italic}`, root)).size;
    assert.ok(roman <= 120 * 1024, `the roman file is ${roman} bytes`);
    assert.ok(italic <= 120 * 1024, `the italic file is ${italic} bytes`);
    assert.match(read("public/fonts/Inter-LICENSE.txt"), /SIL Open Font License, Version 1\.1/);
  });

  test("index.html preloads the roman file with crossorigin, so the preload is the copy the page uses", () => {
    const preloads = [...read("client/index.html").matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
    assert.equal(preloads.length, 1);
    assert.match(preloads[0]!, new RegExp(`href="${INTER_FILES.roman}"`));
    assert.match(preloads[0]!, /as="font"/);
    assert.match(preloads[0]!, /type="font\/woff2"/);
    assert.match(preloads[0]!, /\scrossorigin[\s/>]/);
  });

  test("the About page credits the release the files come from", () => {
    const credit = CREDITS.find((group) => group.id === "font")?.credits[0];
    assert.equal(credit?.title, `Inter ${INTER_VERSION}`);
    assert.equal(credit?.license, "OFL-1.1");
    for (const file of Object.values(INTER_FILES)) assert.ok(credit?.files.includes(`public${file}`), file);
  });

  test("the page and the theme name Inter first, with the system fonts after it for anything it lacks", () => {
    assert.ok(theme.font.body.startsWith(`${INTER_FAMILY}, system-ui,`), theme.font.body);
    assert.match(read("client/globals.css"), new RegExp(`font-family: ${theme.font.body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`));
  });
});
