import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { preloadLazies, type Network } from "../../lib/retryableLazy.ts";
import { DM_CATALOG } from "./catalog/dm.ts";
import type { Catalog } from "./catalog/types.ts";
import { createDmCatalog, dmCatalog } from "./dmCatalog.ts";

const CATALOG: Catalog = { entries: [], fields: [], panels: { monsters: { names: ["creatures"] } } };

function spy(outcomes: ("ok" | "fail")[] = ["ok"]) {
  const calls: number[] = [];
  const load = () => {
    calls.push(calls.length);
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    return outcome === "ok" ? Promise.resolve(CATALOG) : Promise.reject(new Error("offline"));
  };
  return { calls, load };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("the DM's catalog loads for a DM alone (design-v1-qol.md 5, Loading)", () => {
  test("a player, a role not yet known, or anything but exactly dm, loads nothing", () => {
    const { calls, load } = spy();
    const catalog = createDmCatalog(load);
    for (const role of ["player", undefined, null, "", "DM", "display", { role: "dm" }, ["dm"]]) {
      assert.deepEqual(catalog.request(role), { status: "none" });
      catalog.retry(role);
    }
    assert.deepEqual(calls, []);
    assert.equal(catalog.peek("dm").status, "idle");
  });

  test("a DM's first request starts the load once, and the listeners hear it end", async () => {
    const { calls, load } = spy();
    const catalog = createDmCatalog(load);
    let heard = 0;
    catalog.subscribe(() => heard++);
    assert.deepEqual(catalog.request("dm"), { status: "loading" });
    assert.equal(heard, 0, "a request may come from a render, so its step to loading tells no one");
    assert.deepEqual(catalog.request("dm"), { status: "loading" });
    await settle();
    assert.deepEqual(catalog.request("dm"), { status: "ready", catalog: CATALOG });
    assert.equal(heard, 1);
    assert.equal(calls.length, 1);
  });

  test("a failed load stays failed until Try again, which tries once more", async () => {
    const { calls, load } = spy(["fail", "fail", "ok"]);
    const catalog = createDmCatalog(load);
    catalog.request("dm");
    await settle();
    assert.deepEqual(catalog.request("dm"), { status: "failed", tries: 1 });
    await settle();
    assert.equal(calls.length, 1, "no retry from a render");
    catalog.retry("player");
    assert.equal(calls.length, 1);
    catalog.retry("dm");
    assert.equal(catalog.peek("dm").status, "loading");
    await settle();
    assert.deepEqual(catalog.peek("dm"), { status: "failed", tries: 2 }, "the sheet offers Reload once a retry fails too");
    catalog.retry("dm");
    await settle();
    assert.deepEqual(catalog.peek("dm"), { status: "ready", catalog: CATALOG });
    assert.equal(calls.length, 3);
    catalog.retry("dm");
    assert.equal(calls.length, 3, "nothing to retry once ready");
  });

  test("the room's preload starts it for a DM's room only, and it loads catalog/dm.ts", async () => {
    const online: Network = { online: () => true, onceOnline: () => {} };
    preloadLazies("player", online);
    await settle();
    assert.equal(dmCatalog.peek("dm").status, "idle");
    preloadLazies("dm", online);
    assert.equal(dmCatalog.peek("dm").status, "loading");
    await dmCatalog.preload();
    assert.deepEqual(dmCatalog.peek("dm"), { status: "ready", catalog: DM_CATALOG });
  });
});

describe("nothing but dmCatalog.ts imports catalog/dm.ts, and nothing but catalog/dm.ts the files of DM entries (design-v1-qol.md 5, Loading)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const client = resolve(here, "../..");
  const target = resolve(here, "catalog/dm.ts");
  /** The feature files whose entries are the DM's alone, which catalog/dm.ts gathers. */
  const DM_ENTRY_FILES = [
    "features/dm/search.ts",
    "features/settings/search.ts",
    "features/scenes/search.ts",
    "features/clock/search.ts",
    "features/sound/search.ts",
    "features/encounter/search.ts",
    "features/tokens/dmSearch.ts",
  ].map((f) => resolve(client, f));
  const SPEC = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) out.push(...sources(path));
      // Tests and their helpers never ship, so they may read the DM's entries directly.
      else if (/\.tsx?$/.test(d.name) && !/\.(test|testutil)\.tsx?$/.test(d.name)) out.push(path);
    }
    return out;
  }

  /** Every reference to a file in a source (catalog/dm.ts unless named), and whether it is the dynamic import. */
  function references(path: string, text: string, to = target): { dynamic: boolean }[] {
    const out: { dynamic: boolean }[] = [];
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1] ?? m[2];
      if (spec && spec.startsWith(".") && resolve(dirname(path), spec).replace(/\.ts$/, "") === to.replace(/\.ts$/, "")) out.push({ dynamic: m[2] !== undefined });
    }
    return out;
  }

  test("the scan finds what it looks for", () => {
    const fake = join(here, "x.ts");
    assert.deepEqual(references(fake, 'import { DM_CATALOG } from "./catalog/dm.ts";'), [{ dynamic: false }]);
    assert.deepEqual(references(fake, 'import type { X } from "./catalog/dm.ts";'), [{ dynamic: false }]);
    assert.deepEqual(references(fake, 'export * from "./catalog/dm";'), [{ dynamic: false }]);
    assert.deepEqual(references(join(client, "pages", "x.ts"), 'import "../features/search/catalog/dm.ts";'), [{ dynamic: false }]);
    assert.deepEqual(references(fake, 'const m = await import("./catalog/dm.ts");'), [{ dynamic: true }]);
    assert.deepEqual(references(fake, 'import { EVERYONE } from "./catalog/everyone.ts";'), []);
  });

  test("only dmCatalog.ts refers to it, by one dynamic import", () => {
    const found: string[] = [];
    for (const path of sources(client)) {
      for (const ref of references(path, readFileSync(path, "utf8"))) found.push(`${relative(client, path)} ${ref.dynamic ? "dynamic" : "static"}`);
    }
    assert.deepEqual(found, ["features/search/dmCatalog.ts dynamic"]);
  });

  test("each file of DM entries is imported by catalog/dm.ts alone, so its entries stay in the DM's chunk", () => {
    for (const file of DM_ENTRY_FILES) {
      const found: string[] = [];
      for (const path of sources(client)) {
        for (const ref of references(path, readFileSync(path, "utf8"), file)) found.push(`${relative(client, path)} ${ref.dynamic ? "dynamic" : "static"}`);
      }
      assert.deepEqual(found, ["features/search/catalog/dm.ts static"], relative(client, file));
    }
  });
});
