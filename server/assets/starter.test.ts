import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assetCreditSchema } from "#shared/protocol.ts";
import { STARTER_KEY, STARTER_KINDS, indexWorks, starterAssetCredit, type StarterPack, type StarterWork } from "#shared/starter.ts";
import { STARTER_PACKS } from "#shared/starterArt.ts";
import { PLAYER_PICK_FLOOR_MS, StarterWorkError, noSoonerThan, shippedRoot, starterFilePath, starterGrid, workForKind, type FloorClock } from "./starter.ts";

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

describe("where a pick's file is read from", () => {
  test("is the build's dist in production, and public, where Vite serves the tab, anywhere else, even with a dist left behind", () => {
    const always = () => true;
    assert.match(shippedRoot(true, always), /[\\/]dist[\\/]$/);
    assert.match(shippedRoot(false, always), /[\\/]public[\\/]$/);
    assert.match(shippedRoot(true, () => false), /[\\/]public[\\/]$/, "production with no build reads public");
  });
});

describe("a pick's credit", () => {
  const pack: StarterPack = { id: "test-pack", title: "Test", author: "An Artist", page: "https://example.com", wayback: "https://web.archive.org/web/2014/https://example.com", licenses: ["CC-BY-4.0"], changes: "", works: [] };

  test("says the room's copy is WebP only when the shipped file is not", () => {
    assert.equal(starterAssetCredit({ pack, work: work() }).changes, "Resized to 512 px.");
    const ink = work({ file: "/starter/test-pack/inn.png", credit: { ...work().credit, changes: "Reduced to four gray levels and saved as PNG." } });
    assert.equal(starterAssetCredit({ pack, work: ink }).changes, "Reduced to four gray levels and saved as PNG. Converted to WebP for this room.");
  });

  test("links a public domain dedication's snapshot, where the statement can be read, and any other work's own page", () => {
    assert.equal(starterAssetCredit({ pack, work: work() }).landingUrl, "https://example.com/knight");
    const dedicated = work({ credit: { ...work().credit, license: "public-domain-dedication" } });
    assert.equal(starterAssetCredit({ pack, work: dedicated }).landingUrl, pack.wayback);
  });

  test("carries the line the author asks for, the work's before the pack's, else the title and author, never a note about credit", () => {
    assert.equal(starterAssetCredit({ pack, work: work() }).attribution, "Knight by An Artist");
    assert.equal(starterAssetCredit({ pack: { ...pack, attribution: "Cartography by An Artist" }, work: work() }).attribution, "Cartography by An Artist");
    const own = work({ credit: { ...work().credit, attribution: "Knight, by An Artist, for the museum" } });
    assert.equal(starterAssetCredit({ pack: { ...pack, attribution: "Cartography by An Artist" }, work: own }).attribution, "Knight, by An Artist, for the museum");
    const noted = { ...pack, attributionNote: "Not required. The artist asks, as a courtesy, to be credited." };
    assert.equal(starterAssetCredit({ pack: noted, work: work() }).attribution, "Knight by An Artist");
  });
});

describe("a map pick's grid", () => {
  test("is the catalog's on a stored copy of the shipped size, and scales with a smaller copy, origin and all", () => {
    assert.deepEqual(starterGrid({ width: 4096, grid: { cellPx: 70.4, originPx: { x: 12, y: 0.5 } } }, 4096), { cellPx: 70.4, originPx: { x: 12, y: 0.5 } });
    assert.deepEqual(starterGrid({ width: 4096, grid: { cellPx: 70, originPx: { x: 21, y: 9 } } }, 2048), { cellPx: 35, originPx: { x: 10.5, y: 4.5 } });
    assert.deepEqual(starterGrid({ width: 3000, grid: { cellPx: 50 } }, 1000), { cellPx: 16.67 });
  });

  test("is unknown for a map with no drawn grid", () => {
    assert.equal(starterGrid({ width: 4096 }, 4096), undefined);
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

describe("a player's pick floor", () => {
  /** A clock that moves only when told to, or by what is waited on it. */
  function fakeClock(start: number): FloorClock & { at: number; waits: number[] } {
    const clock = {
      at: start,
      waits: [] as number[],
      now: () => clock.at,
      wait: async (ms: number) => {
        clock.waits.push(ms);
        clock.at += ms;
      },
    };
    return clock;
  }

  test("a held work's quick answer waits out the rest of the floor, so it lands when a fresh copy's would", async () => {
    const clock = fakeClock(1000);
    clock.at += 4;
    await noSoonerThan(1000, PLAYER_PICK_FLOOR_MS, clock);
    assert.deepEqual(clock.waits, [PLAYER_PICK_FLOOR_MS - 4]);
    assert.equal(clock.at, 1000 + PLAYER_PICK_FLOOR_MS);
  });

  test("an answer at or past the floor waits nothing more", async () => {
    for (const took of [PLAYER_PICK_FLOOR_MS, PLAYER_PICK_FLOOR_MS + 0.5, 900]) {
      const clock = fakeClock(1000 + took);
      await noSoonerThan(1000, PLAYER_PICK_FLOOR_MS, clock);
      assert.deepEqual(clock.waits, [], `after ${took} ms`);
    }
  });

  test("sits well above the slowest fresh copy measured, 105 ms, so a server three times slower still answers under it", () => {
    assert.ok(PLAYER_PICK_FLOOR_MS > 3 * 105, String(PLAYER_PICK_FLOOR_MS));
  });

  test("a held work's pick done in 3 ms and a fresh copy's done in 380 both answer at the floor", async () => {
    for (const [took, waited] of [
      [3, PLAYER_PICK_FLOOR_MS - 3],
      [380, PLAYER_PICK_FLOOR_MS - 380],
    ] as const) {
      const clock = fakeClock(0);
      clock.at = took;
      await noSoonerThan(0, PLAYER_PICK_FLOOR_MS, clock);
      assert.deepEqual(clock.waits, [waited], `after ${took} ms`);
      assert.equal(clock.at, PLAYER_PICK_FLOOR_MS);
    }
  });
});
