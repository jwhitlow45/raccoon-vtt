import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Stamp } from "#shared/model.ts";
import { drawStamps, loadStampImages, stampUrl } from "./draw.ts";

const assets = { url: (id: string, variant: string) => `/assets/${id}/${variant}` };

describe("stamp images", () => {
  test("a shipped key draws from /stamps, a room image from its full copy, and an unknown key from nothing", () => {
    assert.equal(stampUrl({ key: "tree-1" }, assets), "/stamps/tree-1.webp");
    assert.equal(stampUrl({ assetId: "a1" }, assets), "/assets/a1/full");
    // A key this client does not ship draws as a dashed box rather than asking the server for a path.
    assert.equal(stampUrl({ key: "throne" }, assets), null);
  });

  test("the export's wait for images ends at once when no stamp has one", async () => {
    await loadStampImages([null, null]);
    await loadStampImages([]);
  });
});

/** A 2D context that records, for each picture and outline drawn, the opacity and dash it was drawn with. */
function recorder() {
  const drawn: { what: "art" | "outline"; alpha: number; dashed: boolean }[] = [];
  let state = { alpha: 1, dash: [] as number[] };
  const saved: (typeof state)[] = [];
  const g = {
    get globalAlpha() {
      return state.alpha;
    },
    set globalAlpha(v: number) {
      state.alpha = v;
    },
    lineWidth: 1,
    strokeStyle: "",
    getTransform: () => ({ a: 50, b: 0 }),
    save: () => saved.push({ ...state }),
    restore: () => {
      state = saved.pop() ?? state;
    },
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    setLineDash: (dash: number[]) => {
      state.dash = dash;
    },
    drawImage: () => drawn.push({ what: "art", alpha: state.alpha, dashed: false }),
    strokeRect: () => drawn.push({ what: "outline", alpha: state.alpha, dashed: state.dash.length > 0 }),
  };
  return { g: g as unknown as CanvasRenderingContext2D, drawn };
}

/** A decoded 16 px picture, so the art draws as it is with no copy made. */
class FakeImage {
  decoding = "";
  src = "";
  naturalWidth = 16;
  naturalHeight = 16;
  decode(): Promise<void> {
    return Promise.resolve();
  }
}

function stamp(id: string, visibility: Stamp["visibility"]): Stamp {
  return { id, rev: 1, sceneId: "s1", art: { key: "barrel" }, x: 2, y: 2, w: 0.5, h: 0.5, rotation: 0, z: 0, visibility };
}

describe("drawing stamps", () => {
  test("the DM's board dims a DM-only stamp inside a dashed outline, and the export and thumbnails draw it as it is", async (t) => {
    const real = (globalThis as { Image?: unknown }).Image;
    (globalThis as { Image?: unknown }).Image = FakeImage;
    t.after(() => {
      (globalThis as { Image?: unknown }).Image = real;
    });
    const url = "test://dm-only-stamp-art";
    await loadStampImages([url]);
    const stamps = [stamp("seen", "all"), stamp("hidden", "dm")];
    const opts = { urlOf: () => url, onLoad: () => {} };

    const board = recorder();
    drawStamps(board.g, stamps, { ...opts, dimHidden: true });
    assert.deepEqual(board.drawn, [
      { what: "art", alpha: 1, dashed: false },
      { what: "art", alpha: 0.5, dashed: false },
      { what: "outline", alpha: 1, dashed: true },
    ]);

    const exported = recorder();
    drawStamps(exported.g, stamps, opts);
    assert.deepEqual(exported.drawn, [
      { what: "art", alpha: 1, dashed: false },
      { what: "art", alpha: 1, dashed: false },
    ]);
  });
});
