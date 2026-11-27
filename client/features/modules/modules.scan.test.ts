import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOMES } from "./registry.ts";

/*
 * The source scans of docs/design/design-v1-features.md 8 and 14. Hiding
 * is only as good as the gate's callers, so these keep every caller on it:
 * - Only client/features/modules/ reads `rvtt.features` or the store's
 *   values. Elsewhere the gate's functions read them, with a part's needs,
 *   the preview and the table display taken into account.
 * - The old Roll animation setting is read only by the store's migration,
 *   so nothing shows dice while Dice animation hides (D-261127-396).
 * - A part's tool or panel id reaches `setTool` or `openPanel` outside the
 *   part's own files only at a call the design lists (D-261127-304).
 * - The registry, store and gate import nothing of the room's actions, the
 *   socket or the protocol.
 * - Every home has its Hidden on this device line (section 6).
 * Lanes still to land keep a list of their sites here: each list must
 * shrink to empty, and a listed site that is gone fails, so it is taken
 * off the list in the same change.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MODULES_DIR = "client/features/modules/";

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.testutil\.tsx?$/.test(entry.name)) yield path;
  }
}

const FILES: readonly { file: string; text: string }[] = [...sources(join(ROOT, "client"))].map((path) => ({ file: relative(ROOT, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
const outside = FILES.filter((f) => !f.file.startsWith(MODULES_DIR));

/** Lines that match, as "file:line". */
function sites(files: readonly { file: string; text: string }[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const f of files) f.text.split("\n").forEach((line, i) => pattern.test(line) && out.push(`${f.file}:${i + 1}`));
  return out;
}

/** An import of the store's values: anything but `import type` or a list of `type` names alone. */
function valueImportsOfStore(text: string): boolean {
  for (const m of text.matchAll(/import\s+([^;]*?)\s+from\s+["']([^"']+)["']/gs)) {
    if (!/(^|\/)modules\/store\.ts$/.test(m[2]!)) continue;
    const clause = m[1]!.trim();
    if (clause.startsWith("type ")) continue;
    const names = /^\{([^}]*)\}$/.exec(clause)?.[1];
    if (names !== undefined && names.split(",").every((n) => n.trim() === "" || n.trim().startsWith("type "))) continue;
    return true;
  }
  return false;
}

describe("the parts gate's source scans", () => {
  test("only the modules folder reads the parts store or its key", () => {
    assert.deepEqual(sites(outside, /rvtt\.features/), []);
    assert.deepEqual(outside.filter((f) => valueImportsOfStore(f.text)).map((f) => f.file), []);
  });

  test("the old Roll animation setting is read only by the store's migration", () => {
    const reads = outside.filter((f) => /\b(useRollAnimation|subscribeRollAnimation|setRollAnimation)\b|\brollAnimation\(|rvtt\.rollAnimation/.test(f.text)).map((f) => f.file);
    assert.deepEqual(reads, [], "a file reads Roll animation: read Dice animation through the gate");
  });

  /** Each part's tool and panel ids, and the folders that are the part's own. */
  const OWN: readonly { ids: readonly string[]; folders: readonly string[] }[] = [
    { ids: ["tool:area", "panel:areas"], folders: ["client/features/areas/"] },
    { ids: ["tool:ruler"], folders: ["client/features/measure/"] },
    { ids: ["tool:draw"], folders: ["client/features/drawings/"] },
    { ids: ["tool:ping"], folders: ["client/features/pings/"] },
    { ids: ["tool:pin"], folders: ["client/features/pins/"] },
    { ids: ["tool:trap"], folders: ["client/features/traps/"] },
    { ids: ["tool:build"], folders: ["client/features/builder/"] },
    { ids: ["panel:sound"], folders: ["client/features/sound/"] },
    { ids: ["panel:time"], folders: ["client/features/clock/"] },
    { ids: ["panel:journal"], folders: ["client/features/journal/"] },
    { ids: ["panel:encounters"], folders: ["client/features/encounters/"] },
    { ids: ["panel:outliner"], folders: ["client/features/outliner/"] },
  ];

  /**
   * The calls section 8's table rules, outside the part's own files: each
   * hidden with its part, a borrow's end, a shared link, or the part's own
   * key, chip or row elsewhere.
   */
  const LISTED: readonly string[] = [
    // Centers the map on the thing with no tool while its part hides (FT-C).
    "client/features/outliner/focus.ts tool:area",
    "client/features/outliner/focus.ts tool:build",
    "client/features/outliner/focus.ts tool:pin",
    "client/features/outliner/focus.ts tool:trap",
    // A cast's Place its area, hidden with Areas (FT-C).
    "client/features/dice/cast/CastBlock.tsx tool:area",
    // The borrow's end: the Area tool goes back to the trap's pane (D-261127-303).
    "client/features/areas/AreaOptions.tsx tool:trap",
    // The paste sheet's Stamp row, hidden with Map builder (FT-C).
    "client/features/images/RoomPaste.tsx tool:build",
    // A scene's Open the builder, hidden with Map builder (FT-C).
    "client/features/scenes/SceneSettings.tsx tool:build",
    // A journal page's Pin to the map, hidden with Map pins (FT-C).
    "client/features/journal/JournalPanel.tsx tool:pin",
    // An area group save's panel, which groupSavePanel sends to Dice while Areas hides (FT-C).
    "client/features/dice/DicePanel.tsx panel:areas",
    // The clock chip, which shownBar leaves off the top bar while Date and time hides.
    "client/pages/Room.tsx panel:time",
    // The outliner's own key, which shortcutsFor and shortcutFor leave out while Outliner hides.
    "client/state/shortcuts.ts panel:outliner",
    // A pin's journal page, a shared link that opens Journal once (D-261127-129).
    "client/features/pins/PinController.ts panel:journal",
    "client/features/pins/PinPane.tsx panel:journal",
  ];

  test("a part's tool or panel reaches setTool or openPanel outside its own files only where the design lists the call", () => {
    const constants: Readonly<Record<string, string>> = { SOUND_PANEL: "sound", TIME_PANEL: "time" };
    const found = new Set<string>();
    for (const f of FILES) {
      for (const m of f.text.matchAll(/\b(setTool|openPanel)\(\s*(?:"([a-z-]+)"|([A-Z_]+))/g)) {
        const id = m[2] ?? constants[m[3] ?? ""];
        if (id === undefined) continue;
        const key = `${m[1] === "setTool" ? "tool" : "panel"}:${id}`;
        const own = OWN.find((o) => o.ids.includes(key));
        if (!own || own.folders.some((dir) => f.file.startsWith(dir))) continue;
        found.add(`${f.file} ${key}`);
      }
    }
    assert.deepEqual([...found].sort(), [...LISTED].sort(), "a part's tool or panel is set outside its own files: gate the control with the part, or list the call with its reason, as section 8's table does");
  });

  test("the registry, store and gate import nothing of the room's actions, the socket or the protocol", () => {
    for (const f of FILES.filter((x) => x.file.startsWith(MODULES_DIR))) {
      assert.doesNotMatch(f.text, /from\s+["'][^"']*(state\/actions\.ts|state\/socket\.ts|shared\/protocol\.ts)["']/, f.file);
    }
  });

  /** Homes whose Hidden on this device line the lanes still to land place: FT-D (rest). */
  const HOMES_PENDING = ["rest"];
  /** Homes whose ways back are a menu's own items, read from useHiddenHere, where a menu holds items and not a line of buttons (design section 6, D-261127-482). */
  const MENU_HOMES = ["tools", "menu"];

  test("every home has its Hidden on this device line", () => {
    const lines = outside.flatMap((f) => [...f.text.matchAll(/<HiddenHere\b[^>]*\bhome="([a-zA-Z]+)"/g)].map((m) => m[1]!));
    const items = outside.flatMap((f) => [...f.text.matchAll(/\buseHiddenHere\("([a-zA-Z]+)"/g)].map((m) => m[1]!)).filter((home) => MENU_HOMES.includes(home));
    const placed = new Set([...lines, ...items]);
    for (const home of placed) assert.ok((HOMES as readonly string[]).includes(home), `${home} is not a home`);
    assert.deepEqual(
      HOMES.filter((h) => !placed.has(h)),
      HOMES.filter((h) => HOMES_PENDING.includes(h)),
      "a home gained its line, or one lost it: take a placed home off the pending list",
    );
  });
});
