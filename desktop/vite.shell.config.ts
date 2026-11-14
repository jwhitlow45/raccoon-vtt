import { builtinModules } from "node:module";
import { defineConfig } from "vite";

/**
 * Builds the shell's main process and its preload (design 11.2) into
 * out/main/main.cjs and out/preload/preload.cjs, one at a time by `--mode`,
 * so neither shares a chunk with the other. Each is one CommonJS file with
 * its packages inside, electron-updater and zod included, so the packed app
 * carries no node_modules. Electron itself and Node's built-ins stay outside.
 * The sandboxed preload may require only `electron`, which is all it uses.
 */
const ENTRIES: Record<string, string> = { main: "electron/main.ts", preload: "electron/preload.ts" };

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode];
  if (!entry) throw new Error(`build with --mode main or --mode preload, not ${mode}`);
  const builtins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
  return {
    root: import.meta.dirname,
    publicDir: false,
    logLevel: "warn",
    build: {
      ssr: entry,
      outDir: `out/${mode}`,
      emptyOutDir: true,
      // Electron 44 runs Node 24 in its main process.
      target: "node24",
      minify: false,
      sourcemap: false,
      rollupOptions: {
        external: ["electron", /^electron\//, ...builtins],
        output: { format: "cjs", entryFileNames: `${mode}.cjs` },
      },
    },
    ssr: { noExternal: true, target: "node" },
  };
});
