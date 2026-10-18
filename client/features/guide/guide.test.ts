import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseMarkdown, type Block, type Inline } from "../../components/markdown.ts";
import { parseRoute } from "../../lib/router.ts";
import { PANELS } from "../panels.ts";
import { GUIDE_PATH, guideBody, guideHref, guideImageName, guideImageSize } from "./guide.ts";

const DOCS = new URL("../../../docs/", import.meta.url);
const SOURCE = readFileSync(new URL("dm-guide.md", DOCS), "utf8");
const BLOCKS = parseMarkdown(guideBody(SOURCE), { guide: true });

function inlinesOf(blocks: Block[]): Inline[][] {
  return blocks.flatMap((b): Inline[][] => {
    switch (b.kind) {
      case "heading":
      case "paragraph":
        return [b.content];
      case "list":
        return [...b.items, ...(b.sub ?? []).flat()];
      case "table":
        return [...b.header, ...b.rows.flat()];
      case "quote":
        return inlinesOf(b.blocks);
      case "image":
        return [];
    }
  });
}

function linksIn(content: Inline[]): string[] {
  return content.flatMap((n) => (n.kind === "link" ? [n.href, ...linksIn(n.children)] : n.kind === "bold" || n.kind === "italic" ? linksIn(n.children) : []));
}

const IDS = new Set(BLOCKS.flatMap((b) => (b.kind === "heading" && b.id ? [b.id] : [])));
const IMAGES = BLOCKS.flatMap((b) => (b.kind === "image" ? [b.src] : []));

/** A WebP file's width and height from its header, for each of the three kinds of first chunk. */
function webpSize(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WEBP");
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  assert.equal(chunk, "VP8X");
  return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
}

describe("the DM guide's page", () => {
  test("/docs/dm-guide is the guide, in production builds too", () => {
    assert.equal(GUIDE_PATH, "/docs/dm-guide");
    assert.deepEqual(parseRoute("/docs/dm-guide", { dev: false }), { name: "guide" });
    assert.deepEqual(parseRoute("/docs/dm-guide/", { dev: false }), { name: "guide" });
    assert.deepEqual(parseRoute("/docs/features", { dev: false }), { name: "notFound" });
    assert.equal(guideHref(), "/docs/dm-guide");
    assert.equal(guideHref("areas"), "/docs/dm-guide#areas");
  });

  test("the page drops the guide's own title, which it shows as its heading", () => {
    assert.ok(SOURCE.startsWith("# DM guide\n"));
    assert.ok(!guideBody(SOURCE).startsWith("# DM guide"));
    assert.ok(!BLOCKS.some((b) => b.kind === "heading" && b.id === "dm-guide"));
  });

  test("every link to a section finds its heading, and the Contents button's target is there", () => {
    assert.ok(IDS.has("contents"));
    const anchors = inlinesOf(BLOCKS)
      .flatMap(linksIn)
      .filter((href) => href.startsWith("#"));
    assert.ok(anchors.length > 40, `only ${anchors.length} links to sections`);
    for (const href of anchors) assert.ok(IDS.has(href.slice(1)), `${href} has no heading`);
  });

  test("the section ids are the ones GitHub gives, so one link works in both places", () => {
    for (const id of ["quick-start", "initiative", "areas", "hp-damage-and-conditions", "ping-look-here-and-pins", "map-phases-imports-and-exports", "a-forest-road-ambush"]) {
      assert.ok(IDS.has(id), id);
    }
  });

  test("each panel's Guide link finds its section", () => {
    const linked = PANELS.filter((p) => p.guide !== undefined);
    assert.deepEqual(
      linked.map((p) => p.id).sort(),
      ["areas", "characters", "dice", "dm", "encounters", "monsters", "outliner", "scenes", "token", "tracker"],
    );
    for (const p of linked) assert.ok(IDS.has(p.guide!), `${p.id}: #${p.guide}`);
    assert.ok(IDS.has("quick-start"), "the empty states' link");
  });

  test("every image is in the guide's folder, every file there is shown, and each has the size the page gives it", () => {
    const files = readdirSync(new URL("dm-guide/", DOCS)).filter((f) => !f.startsWith("."));
    const named = IMAGES.map((src) => guideImageName(src));
    assert.ok(named.every((n) => n !== null), `outside dm-guide/: ${IMAGES.filter((src) => !guideImageName(src)).join(", ")}`);
    assert.deepEqual([...new Set(named)].sort(), [...files].sort());
    for (const file of files) {
      assert.deepEqual(webpSize(readFileSync(new URL(`dm-guide/${file}`, DOCS))), guideImageSize(file), file);
    }
  });

  test("an image path outside the guide's folder is never mapped", () => {
    assert.equal(guideImageName("dm-guide/fog.webp"), "fog.webp");
    assert.equal(guideImageName("dm-guide/../secret.webp"), null);
    assert.equal(guideImageName("other/fog.webp"), null);
    assert.equal(guideImageName("dm-guide/fog.png"), null);
  });
});
