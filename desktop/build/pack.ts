/**
 * Packs the desktop app with electron-builder (design 11.2), for this
 * computer's platform and architecture, as each build job runs on its own
 * runner:
 *
 *   node desktop/build/pack.ts [--dir] [--stage <app-server folder>]
 *
 * It needs `pnpm build` (the web app), `pnpm desktop:fetch` (Node and
 * PostgreSQL in desktop/.runtime), desktop/scripts/stage.ts (the staged
 * server) and `pnpm --dir desktop build` (the shell and the window) first.
 * `--dir` makes only the unpacked app, as the e2e test and the smoke test
 * use it. `--stage` names the staged server, by default where stage.ts puts
 * it: `$RUNNER_TEMP/raccoonvtt-stage/app-server`, or the same under the
 * system's temp folder off CI.
 *
 * electron-builder.yml holds the settings. This adds what it cannot: the
 * staged server, which sits outside the repository (electron-builder would
 * read an absolute path in the file as one inside desktop/), and the app's
 * version, which is the repository's own, so a release bumps one file.
 *
 * `--shell-only` packs without Node, PostgreSQL or the staged server, for
 * the shell's e2e test, which puts a stand-in supervisor in a copy.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "electron-builder";
import { RESOURCES, SUPERVISOR_ENTRY, serverBinaryName, type Platform } from "../contract.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
const ROOT = resolve(DESKTOP, "..");

export function defaultStage(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.RUNNER_TEMP || tmpdir(), "raccoonvtt-stage", RESOURCES.appServer);
}

/** What a full build cannot do without, so a broken fetch or stage fails here rather than in a DM's install. */
export function missingPieces(stage: string, platform: Platform, exists: (path: string) => boolean = existsSync): string[] {
  const needed = [
    join(DESKTOP, ".runtime", RESOURCES.node, serverBinaryName(platform)),
    join(DESKTOP, ".runtime", RESOURCES.postgres),
    join(stage, SUPERVISOR_ENTRY),
    join(DESKTOP, "out", "main", "main.cjs"),
    join(DESKTOP, "out", "preload", "preload.cjs"),
    join(DESKTOP, "out", "window", "index.html"),
  ];
  return needed.filter((path) => !exists(path));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dir: { type: "boolean", default: false },
      stage: { type: "string" },
      "shell-only": { type: "boolean", default: false },
    },
  });
  const platform = process.platform as Platform;
  const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const stage = resolve(values.stage ?? defaultStage());
  const shellOnly = values["shell-only"];
  const missing = missingPieces(stage, platform).filter((path) => !shellOnly || path.includes(join("out", "main")) || path.includes(join("out", "preload")));
  if (missing.length > 0) {
    console.error(`Cannot pack RaccoonVTT. Missing:\n${missing.map((m) => `  ${m}`).join("\n")}`);
    process.exit(1);
  }
  // electron-builder reads the afterPack hook's path from the working folder.
  process.chdir(DESKTOP);
  const artifacts = await build({
    projectDir: DESKTOP,
    publish: "never",
    dir: values.dir,
    config: {
      extends: "build/electron-builder.yml",
      extraMetadata: { version },
      extraResources: shellOnly ? [] : [{ from: stage, to: RESOURCES.appServer }],
    },
  });
  for (const file of artifacts) console.log(file);
}
