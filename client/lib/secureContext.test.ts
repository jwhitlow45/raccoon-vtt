import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The desktop app serves plain HTTP on the local network, where these APIs
 * are missing (docs/design/design-v1-local-app.md 5). A use outside the
 * list below fails, so a new one is checked for a fallback before it ships.
 * Each listed file was read for that: it tests for the API first, or has a
 * fallback, or only names it in a comment.
 */
const API =
  /navigator\.(clipboard|share|canShare|wakeLock|locks|keyboard)\b|"(wakeLock|locks|keyboard)" in navigator|crypto\.(randomUUID|subtle)\b|"randomUUID" in crypto|\bserviceWorker\b|\baudioWorklet\b|\bshowSaveFilePicker\b/g;

const GUARDED: Record<string, string> = {
  "client/lib/clipboard.ts": "the only writer, with an execCommand fallback",
  "client/features/images/PasteImage.tsx": "checks navigator.clipboard.read before use, and pastes use the paste event",
  "client/features/images/pasteRouter.ts": "comment only",
  "client/features/images/paste.ts": "comment only",
  "client/features/mapexport/save.ts": "checks navigator.share and canShare before use",
  "client/features/dm/controls.tsx": "Share hides without navigator.share",
  "client/pages/Home.tsx": "Share hides without navigator.share",
  "client/lib/wakeLock.ts": "skips without wakeLock in navigator",
  "client/pages/AskToJoin.tsx": "checks locks in navigator",
  "client/features/sound/engine/handoff.ts": "browserLocks returns null without navigator.locks",
  "client/lib/fullscreen.ts": "navigator.keyboard is checked before use",
  "client/features/sound/engine/engine.ts": "checks randomUUID in crypto and has a fallback",
  "shared/ids.ts": "comment only",
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* sources(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|itest)\.tsx?$/.test(entry.name)) yield full;
  }
}

test("secure-context APIs are used only in listed, guarded files", () => {
  const found = new Map<string, Set<string>>();
  for (const dir of ["client", "shared"]) {
    for (const file of sources(path.join(ROOT, dir))) {
      const hits = readFileSync(file, "utf8").match(API);
      if (hits) found.set(path.relative(ROOT, file).split(path.sep).join("/"), new Set(hits));
    }
  }
  const unlisted = [...found].filter(([file]) => !(file in GUARDED)).map(([file, hits]) => `${file}: ${[...hits].join(", ")}`);
  assert.deepEqual(unlisted, [], "a secure-context API needs a fallback on plain HTTP: guard it, then list the file in GUARDED");
  const stale = Object.keys(GUARDED).filter((file) => !found.has(file));
  assert.deepEqual(stale, [], "listed files that no longer use one: remove them from GUARDED");
});

test("the scan finds what it should", () => {
  for (const sample of ["navigator.clipboard.writeText(x)", "navigator.share({})", 'if ("locks" in navigator)', "crypto.randomUUID()", "crypto.subtle.digest()", "navigator.serviceWorker.register()", "showSaveFilePicker()"]) {
    assert.ok(sample.match(API), sample);
  }
});
