import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The source scan (C36): every place in client/, shared/, server/ and
 * scripts/ that names `uuidv7`, uses `z.uuidv7()`, reads a UUID's version
 * digit in a pattern or an id's first 48 bits as a time, counted per file
 * and kept to this list. A new one fails until it is listed here with why
 * it may make or read a version 7 id. Tests and test helpers are left out.
 */

type Uses = { uuidv7?: number; zUuidv7?: number; digit?: number; time?: number };

/** One tool's use: it names version 7 ids it makes, on a server started by e2e/harness.ts, whose seed holds the cutover far ahead. */
const TOOL: Uses = { uuidv7: 1 };

const LISTED: Record<string, Uses> = {
  // The maker and the readers of both versions.
  "shared/ids.ts": { uuidv7: 2, digit: 2, time: 2 },
  // Roll tags (M4): they reach only the roller, or a target's players with a line that states its time.
  "client/features/combat/CombatUses.tsx": { uuidv7: 2 },
  "client/features/combat/DeathSaveCard.tsx": { uuidv7: 2 },
  "client/features/dice/useDicePanel.ts": { uuidv7: 2 },
  "client/features/dice/useRollOption.ts": { uuidv7: 4 },
  "client/features/encounter/RechargeCard.tsx": { uuidv7: 2 },
  // A comment on roll tags' order, which stays time order (O6).
  "client/features/combat/logic.ts": { uuidv7: 1 },
  // Group save plan and page ids and roll tags (M5): the DM's alone, and the reducer reads a plan's age from its id.
  "client/features/dice/groupSave/GroupSave.tsx": { uuidv7: 8 },
  "client/features/dice/groupSave/start.ts": { uuidv7: 2 },
  "client/features/dice/groupSave/reopenContract.ts": { uuidv7: 3, zUuidv7: 3 },
  "client/features/dice/groupSave/chain.ts": { time: 1 },
  "shared/reducer/saveOutcomes.ts": { time: 1 },
  "shared/saveOutcomeContract.ts": { uuidv7: 1, zUuidv7: 1 },
  // A preview's own ids and a form's id, which never reach the room (M8).
  "client/features/dm/preview.ts": { uuidv7: 2 },
  "client/features/tokens/characterPage.ts": { uuidv7: 2 },
  // The client id, and a page's ids while it holds no key (store.ts newId, ids.ts freshIds).
  "client/state/store.ts": { uuidv7: 3 },
  "client/state/ids.ts": { uuidv7: 2 },
  // A fog gesture's op ids take either version (GESTURE_OP).
  "client/features/fog/shapes.ts": { digit: 1 },
  // Member ids and a new room's first scene (M10), and an import's members (M9).
  "shared/initial.ts": { uuidv7: 2 },
  "server/auth/roomRecords.ts": { uuidv7: 2 },
  "server/rooms/importRoom.ts": { uuidv7: 2 },
  // A comment on a member id's length.
  "server/rooms/sizeGuard.ts": { uuidv7: 1 },
  // The first load's finder of version 7 ids.
  "server/rooms/reid.ts": { digit: 1 },
  // Tools.
  "scripts/bench-iso.ts": { uuidv7: 2 },
  "scripts/bench-server4.ts": { uuidv7: 2 },
  "scripts/guide-discovery.ts": { uuidv7: 5 },
  "scripts/guide-dungeon-phase3.ts": TOOL,
  "scripts/guide-floors-desk.ts": TOOL,
  "scripts/guide-floors-phase3.ts": TOOL,
  "scripts/guide-floors-phase4.ts": TOOL,
  "scripts/guide-floors-stairs.ts": TOOL,
  "scripts/guide-hex-relief.ts": TOOL,
  "scripts/guide-iso.ts": TOOL,
  "scripts/guide-music.ts": TOOL,
  "scripts/guide-panel-size.ts": TOOL,
  "scripts/guide-pervision.ts": TOOL,
  "scripts/guide-scenes.ts": TOOL,
  "scripts/guide-scenes/lib.ts": TOOL,
  "scripts/guide-scenes/s03-chars.ts": TOOL,
  "scripts/guide-scenes/s04-forestdraft.ts": TOOL,
  "scripts/guide-scenes/s124-knownforms.ts": TOOL,
  "scripts/guide-scenes/s136-resync.ts": TOOL,
  "scripts/guide-scenes/s143-ddbres.ts": TOOL,
  "scripts/guide-scenes/s150-hexkeep.ts": TOOL,
  "scripts/guide-scenes/s156-narrow.ts": TOOL,
  "scripts/guide-scenes/s16-crypt.ts": TOOL,
  "scripts/guide-scenes/s80-tower.ts": TOOL,
  "scripts/guide-scenes/s86-lair.ts": TOOL,
  "scripts/guide-search.ts": TOOL,
  "scripts/guide-snapoff.ts": TOOL,
  "scripts/guide-theme.ts": TOOL,
  "scripts/guide-time.ts": TOOL,
  "scripts/guide-timed.ts": TOOL,
};

const ROOT = new URL("..", import.meta.url).pathname;
const LEFT_OUT = /(\.test\.ts|\.itest\.ts|Testing\.ts|[tT]estutil\.ts|\.testkit\.ts)$/;

/** Each file's uses, for every file with one. */
function scan(dirs: readonly string[] = ["client", "shared", "server", "scripts"]): Record<string, Uses> {
  const out: Record<string, Uses> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(name) || LEFT_OUT.test(name)) continue;
      const text = readFileSync(join(ROOT, rel), "utf8");
      const count = (re: RegExp) => (text.match(re) ?? []).length;
      const uses: Uses = {};
      const found = {
        uuidv7: count(/\buuidv7\b/g),
        zUuidv7: count(/\bz\.uuidv7\(\)/g),
        // A UUID pattern's third group that names its version.
        digit: count(/\{4\}-(?:7|8|\[78\]|\[1-8\])/g),
        // A version 7 id's time read from its first 48 bits.
        time: count(/slice\(0, ?8\)[^;\n]{0,16}slice\(9, ?13\)|(?:replace\(\/-\/g, ?|replaceAll\(["']-["'], ?)""\)\.slice\(0, ?12\)/g),
      };
      for (const [k, v] of Object.entries(found)) if (v > 0) uses[k as keyof Uses] = v;
      if (Object.keys(uses).length > 0) out[rel] = uses;
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

test("C36: every maker and reader of version 7 ids is one the list names, with as many uses", () => {
  assert.deepEqual(scan(), LISTED);
});
