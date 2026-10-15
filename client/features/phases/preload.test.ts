import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapPhase } from "#shared/model.ts";
import { phasePreloads } from "./preload.ts";

const phase = (id: string, assetId: string): MapPhase => ({ id, name: id, assetId, widthPx: 3000, heightPx: 2000 });
const url = (assetId: string, variant: string) => `/api/assets/${assetId}/${variant}`;

describe("which phase images a DM device fetches ahead", () => {
  test("every image but the one showing, once each, in the list's order", () => {
    const phases = [phase("day", "a1"), phase("night", "a2"), phase("dawn", "a2"), phase("fire", "a3")];
    assert.deepEqual(
      phasePreloads(phases, "a1", "full", url).map((t) => t.url),
      ["/api/assets/a2/full", "/api/assets/a3/full"],
    );
  });

  test("the variant this device draws, with the full one behind it as the map layer has", () => {
    assert.deepEqual(phasePreloads([phase("day", "a1"), phase("night", "a2")], "a1", "mobile", url), [
      { url: "/api/assets/a2/mobile", fallback: "/api/assets/a2/full" },
    ]);
    assert.deepEqual(phasePreloads([phase("day", "a1"), phase("night", "a2")], "a1", "full", url), [{ url: "/api/assets/a2/full", fallback: null }]);
  });

  test("a scene without phases, which is every scene a player receives, fetches nothing", () => {
    assert.deepEqual(phasePreloads(undefined, "a1", "mobile", url), []);
    assert.deepEqual(phasePreloads([phase("day", "a1")], "a1", "mobile", url), []);
  });
});
