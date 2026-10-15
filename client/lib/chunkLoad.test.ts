import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkUrlFrom, classifyLoadFailure, isChunkLoadError, moduleScripts, reloadGate, type LoadProbe, type ProbeResponse } from "./chunkLoad.ts";
import { RetryableLoad, retryFailedLoads } from "./retryableLazy.ts";

const ORIGIN = "https://raccoon.example";
const PAGE = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AAAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-BBBB.js">
</head><body><div id="root"></div></body></html>`;
const NEW_PAGE = PAGE.replace("index-AAAA", "index-CCCC");
const chromeError = new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/assets/LogPanel-DDDD.js`);

function probe(routes: Record<string, ProbeResponse | "network">, options: { online?: boolean } = {}): LoadProbe & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    online: () => options.online ?? true,
    origin: ORIGIN,
    scripts: () => ["/assets/index-AAAA.js"],
    async fetch(url) {
      asked.push(url);
      const route = routes[url];
      if (route === "network" || route === undefined) throw new TypeError("Failed to fetch");
      return route;
    },
  };
}

const html = (text: string): ProbeResponse => ({ status: 200, contentType: "text/html; charset=utf-8", text });
const js: ProbeResponse = { status: 200, contentType: "text/javascript", text: "export default 1" };

describe("chunk load failures", () => {
  test("module load errors from each engine are recognized, other errors are not", () => {
    assert.equal(isChunkLoadError(chromeError), true);
    assert.equal(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/a.js")), true);
    assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true);
    assert.equal(
      isChunkLoadError(new TypeError('Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".')),
      true,
    );
    assert.equal(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css")), true);
    assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'hp')")), false);
    assert.equal(isChunkLoadError("Failed to fetch dynamically imported module"), false);
  });

  test("the failed chunk's URL is read from the message when there is one", () => {
    assert.equal(chunkUrlFrom(chromeError), `${ORIGIN}/assets/LogPanel-DDDD.js`);
    assert.equal(chunkUrlFrom(new TypeError("Importing a module script failed.")), null);
  });

  test("a page's module scripts are read in order, as paths", () => {
    assert.deepEqual(moduleScripts(PAGE, ORIGIN), ["/assets/index-AAAA.js"]);
    assert.deepEqual(moduleScripts(`<script src="/a.js"></script><script src='/b.js' type=module></script>`, ORIGIN), ["/b.js"]);
    assert.deepEqual(moduleScripts(`<script type="module" src="${ORIGIN}/c.js?v=1"></script>`, ORIGIN), ["/c.js"]);
  });

  test("offline: the browser says so, or the page itself cannot be fetched", async () => {
    assert.equal(await classifyLoadFailure(chromeError, probe({ [`${ORIGIN}/`]: html(PAGE) }, { online: false })), "offline");
    assert.equal(await classifyLoadFailure(chromeError, probe({ [`${ORIGIN}/`]: "network" })), "offline");
  });

  test("updated: a fresh copy of the page loads other scripts", async () => {
    const p = probe({ [`${ORIGIN}/`]: html(NEW_PAGE) });
    assert.equal(await classifyLoadFailure(chromeError, p), "updated");
    assert.deepEqual(p.asked, [`${ORIGIN}/`]);
  });

  test("updated: the chunk is missing, or comes back as the HTML page, while the page looks unchanged", async () => {
    const chunk = `${ORIGIN}/assets/LogPanel-DDDD.js`;
    assert.equal(await classifyLoadFailure(chromeError, probe({ [`${ORIGIN}/`]: html(PAGE), [chunk]: { status: 404, contentType: "application/json", text: "{}" } })), "updated");
    assert.equal(await classifyLoadFailure(chromeError, probe({ [`${ORIGIN}/`]: html(PAGE), [chunk]: html(PAGE) })), "updated");
  });

  test("failed: everything is where it was, so the same load is worth another try", async () => {
    const chunk = `${ORIGIN}/assets/LogPanel-DDDD.js`;
    assert.equal(await classifyLoadFailure(chromeError, probe({ [`${ORIGIN}/`]: html(PAGE), [chunk]: js })), "failed");
    // Safari names no URL, so only the page can tell.
    assert.equal(await classifyLoadFailure(new TypeError("Importing a module script failed."), probe({ [`${ORIGIN}/`]: html(PAGE) })), "failed");
    // A development page served by Vite: the same scripts both times.
    assert.equal(await classifyLoadFailure(chromeError, probe({ [`${ORIGIN}/`]: { ...html(PAGE), status: 500 }, [chunk]: js })), "failed");
  });

  test("a chunk on another origin is never probed", async () => {
    const p = probe({ [`${ORIGIN}/`]: html(PAGE) });
    await classifyLoadFailure(new TypeError("Failed to fetch dynamically imported module: https://cdn.example/x.js"), p);
    assert.deepEqual(p.asked, [`${ORIGIN}/`]);
  });
});

describe("reloading after an update", () => {
  test("a reload waits until every queued op has its answer, and for the connection", () => {
    assert.deepEqual(reloadGate({ pending: 0, connection: "open" }), { ready: true, status: null });
    assert.deepEqual(reloadGate({ pending: 0, connection: "offline" }), { ready: false, status: "Waiting for the connection…" });
    assert.deepEqual(reloadGate({ pending: 1, connection: "open" }), { ready: false, status: "Saving 1 change first…" });
    assert.deepEqual(reloadGate({ pending: 3, connection: "reconnecting" }), {
      ready: false,
      status: "Waiting for the connection to save 3 changes first.",
    });
  });
});

describe("retryable loads", () => {
  test("a failed load stays failed until a retry is asked for, then loads again", async () => {
    let calls = 0;
    let fail = true;
    const load = new RetryableLoad(async () => {
      calls += 1;
      if (fail) throw new TypeError("Failed to fetch dynamically imported module: x");
      return "panel";
    });
    await assert.rejects(load.run());
    assert.equal(load.generation, 0);
    // Rendering again before Retry must not start another load: the generation is unchanged.
    assert.equal(load.generation, 0);
    fail = false;
    retryFailedLoads();
    assert.equal(load.generation, 1);
    assert.equal(await load.run(), "panel");
    assert.equal(calls, 2);
    // A load that worked is never reset by a later retry.
    retryFailedLoads();
    assert.equal(load.generation, 1);
  });
});
