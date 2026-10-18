import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { copyUrls } from "./findGrid.ts";
import { runSearch, type SearchDeps } from "./searchRun.ts";
import { drawMap } from "./synthetic.ts";

/** A server whose phone-sized copy is missing and whose full image is there, and a decoder that counts what it is given. */
function server() {
  const full = new Blob(["the 8192 px original"]);
  const fetched: string[] = [];
  const decoded: Blob[] = [];
  const deps: SearchDeps = {
    async fetch(url) {
      fetched.push(url);
      return url.endsWith("/mobile") ? { ok: false, blob: async () => new Blob() } : { ok: true, blob: async () => full };
    },
    async pixels(blob) {
      decoded.push(blob);
      return drawMap({ width: 400, height: 300, seed: 1, art: [], noise: 2, grid: { cellPx: 40, origin: { x: 0, y: 0 } } });
    },
  };
  return { full, fetched, decoded, deps };
}

const url = (variant: "mobile" | "full") => `/assets/m1/${variant}`;

describe("a search of a map already uploaded", () => {
  test("on a phone or an iPad, a phone copy that fails is no grid, and the full image never reaches the decoder", async () => {
    for (const device of ["phone", "iPad"] as const) {
      const { fetched, decoded, deps } = server();
      assert.deepEqual(await runSearch({ urls: copyUrls(device, url) }, deps), { t: "error" }, device);
      assert.deepEqual(fetched, ["/assets/m1/mobile"], `${device}: only the phone copy is asked for`);
      assert.equal(decoded.length, 0, `${device}: nothing decoded`);
    }
  });

  test("a computer falls back to the full image", async () => {
    const { full, fetched, decoded, deps } = server();
    const answer = await runSearch({ urls: copyUrls("computer", url) }, deps);
    assert.equal(answer.t, "done");
    assert.deepEqual(fetched, ["/assets/m1/mobile", "/assets/m1/full"]);
    assert.deepEqual(decoded, [full]);
  });

  test("a picked file is searched as it is, with nothing fetched", async () => {
    const { fetched, decoded, deps } = server();
    const file = new Blob(["picked"]);
    const answer = await runSearch({ file }, deps);
    assert.ok(answer.t === "done" && answer.result.found, "the drawn grid is found");
    assert.deepEqual(fetched, []);
    assert.deepEqual(decoded, [file]);
  });
});
