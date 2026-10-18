import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assetCreditSchema } from "#shared/protocol.ts";
import { STARTER_KEY, STARTER_KINDS, indexWorks, starterAssetCredit, type StarterPack, type StarterWork } from "#shared/starter.ts";
import { STARTER_PACKS } from "#shared/starterArt.ts";
import { StarterWorkError, starterCellPx, starterFilePath, workForKind } from "./starter.ts";

const root = join("/srv", "app", "dist");

function work(over: Partial<StarterWork> = {}): StarterWork {
  return {
    key: "test-pack/knight",
    id: "TP-01",
    name: "Knight",
    category: "Heroes",
    tags: [],
    uses: ["token", "handout"],
    file: "/starter/test-pack/knight.webp",
    sha256: "ab".repeat(32),
    width: 512,
    height: 512,
    bytes: 1000,
    original: { width: 1024, height: 1024 },
    credit: { title: "Knight", author: "An Artist", source: "https://example.com/knight", license: "CC-BY-4.0", changes: "Resized to 512 px." },
    ...over,
  };
}

describe("a starter work's file", () => {
  test("a served path of the starter shape is a file under the root", () => {
    assert.equal(starterFilePath(root, "/starter/test-pack/knight.webp"), join(root, "starter", "test-pack", "knight.webp"));
    assert.equal(starterFilePath(root, "/starter/dyson-logos/inn-01.png"), join(root, "starter", "dyson-logos", "inn-01.png"));
  });

  test("any other path is refused before a file is named, whatever the catalog says", () => {
    for (const file of [
      "/starter/../package.json",
      "/starter/test-pack/../../server/main.ts",
      "/starter/test-pack/thumbs/knight.webp",
      "/stamps/test-pack-bench.webp",
      "/starter/Test-Pack/knight.webp",
      "/starter/test-pack/knight.svg",
      "starter/test-pack/knight.webp",
      "/starter/test-pack/knight.webp\u0000.png",
      "//starter/test-pack/knight.webp",
    ]) {
      assert.throws(() => starterFilePath(root, file), StarterWorkError, file);
    }
  });
});

describe("a work for a kind", () => {
  const catalog = { root, works: indexWorks([{ id: "test-pack", title: "Test", author: "An Artist", page: "https://example.com", wayback: "https://web.archive.org/x", licenses: ["CC-BY-4.0"], changes: "", works: [work(), work({ key: "test-pack/bench", uses: ["stamp"], file: "/stamps/test-pack-bench.webp" })] }]) };

  test("is found only when the kind is among its uses", () => {
    assert.equal(workForKind(catalog, "test-pack/knight", "token")?.work.key, "test-pack/knight");
    assert.equal(workForKind(catalog, "test-pack/knight", "handout")?.work.key, "test-pack/knight");
    assert.equal(workForKind(catalog, "test-pack/knight", "map"), undefined);
    assert.equal(workForKind(catalog, "test-pack/bench", "token"), undefined);
    assert.equal(workForKind(catalog, "test-pack/nope", "token"), undefined);
  });
});

describe("a map pick's cell size", () => {
  test("is the catalog's on a stored copy of the shipped size, and scales with a smaller copy", () => {
    assert.equal(starterCellPx({ width: 4096, grid: { cellPx: 70.4 } }, 4096), 70.4);
    assert.equal(starterCellPx({ width: 4096, grid: { cellPx: 70 } }, 2048), 35);
    assert.equal(starterCellPx({ width: 3000, grid: { cellPx: 50 } }, 1000), 16.67);
  });

  test("is unknown for a map with no drawn grid", () => {
    assert.equal(starterCellPx({ width: 4096 }, 4096), undefined);
  });
});

/**
 * The shipped catalog, once the build has written it. Each copyable work
 * must be one a pick can store: a path of the starter shape, a pinned hash,
 * and a credit the asset rows' schema reads, since a credit it refused
 * would be stored and never shown.
 */
describe("the shipped catalog", () => {
  const packs: readonly StarterPack[] = STARTER_PACKS;
  const copyable = packs.flatMap((pack) => pack.works.filter((w) => w.uses.some((use) => (STARTER_KINDS as readonly string[]).includes(use))).map((w) => ({ pack, work: w })));

  test("every copyable work names a starter file, a hash and a credit the asset schema reads", { skip: copyable.length === 0 ? "the catalog is empty until the build fills it" : false }, () => {
    for (const found of copyable) {
      const { work: w } = found;
      assert.match(w.key, STARTER_KEY, w.key);
      assert.ok(w.key.startsWith(`${found.pack.id}/`), w.key);
      assert.doesNotThrow(() => starterFilePath(root, w.file), w.file);
      assert.match(w.sha256, /^[0-9a-f]{64}$/, w.key);
      const credit = assetCreditSchema.safeParse(starterAssetCredit(found));
      assert.ok(credit.success, `${w.key}: ${credit.error?.issues[0]?.message ?? ""}`);
    }
  });
});
