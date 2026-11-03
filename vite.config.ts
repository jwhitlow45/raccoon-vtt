import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const JSON_IMPORT_WITH_ATTRIBUTE = /(import\(\s*(["'])[^"'\n]+\.json\2)\s*,\s*\{\s*with\s*:\s*\{\s*type\s*:\s*(["'])json\3\s*\}\s*,?\s*\}\s*\)/g;

/**
 * Shared code loads JSON with `import("./x.json", { with: { type: "json" } })`
 * (shared/srd/monsters.ts), because Node refuses a JSON import without the
 * attribute. A build turns the JSON into a JavaScript chunk and drops the
 * attribute itself. The dev server also serves the JSON as JavaScript but
 * keeps the attribute, and a browser refuses a JSON import that arrives as
 * JavaScript. So in development only, this drops the attribute, and one
 * loader works in Node, in the build and in the dev server.
 */
function devJsonImports(): Plugin {
  return {
    name: "raccoon:dev-json-imports",
    apply: "serve",
    transform(code) {
      if (!code.includes("json")) return null;
      const out = code.replace(JSON_IMPORT_WITH_ATTRIBUTE, "$1)");
      // Dropping text inside one line changes no line breaks, so line mappings stay right without a map.
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * Vite's placeholder for an imported asset's URL (formatBuiltAsset): the
 * bundler's reference id for the emitted file, then an id of its own when the
 * import named a query or fragment to keep.
 */
const ASSET_PLACEHOLDER = /import\.meta\.ROLLDOWN_FILE_URL_([\w$]{22})(?:_[a-f\d]{24})?/g;

/**
 * Writes the same source maps from every build of one commit
 * (build_repeatable). Vite's build turns `import x from "./a.webp?url"` into
 * a module whose whole text is a placeholder naming the file the bundler
 * emits. The bundler numbers emitted files in the order it is handed them,
 * and Vite hands each one over when reading it from disk finishes, so a module
 * that imports many at once (the DM guide's screenshots, by
 * `import.meta.glob`) gets them numbered in a new order each build. The
 * bundled code comes out the same, since every placeholder becomes the
 * file's hashed URL, but a source map embeds each module's text from before
 * that. So each placeholder in a map becomes the URL the bundled code has in
 * its place, short of any query or fragment the import kept. It starts where
 * the placeholder did, so the map's positions still hold. Leaving these
 * modules out of the map instead would mean renumbering every mapping in it.
 */
export function stableAssetMaps(): Plugin {
  let base = "/";
  return {
    name: "raccoon:stable-asset-maps",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".map") || typeof file.source !== "string") continue;
        // Inside the map's JSON, so the URL is written as a JSON string within a JSON string.
        file.source = file.source.replace(ASSET_PLACEHOLDER, (_whole, referenceId: string) => JSON.stringify(JSON.stringify(base + this.getFileName(referenceId))).slice(1, -1));
      }
    },
  };
}

const PDFJS = new URL("./node_modules/pdfjs-dist/", import.meta.url);

/**
 * pdf.js's two plain JavaScript image decoders, which a PDF handout's
 * scanned pages need, and the licenses that cover them and pdf.js
 * (docs/design/design-v1-pdf-handouts.md 4.2.4). The job's worker loads the
 * decoders from the app's own origin, from a folder named by the installed
 * version, so a new pin is a new URL and a file under one name never
 * changes. The build writes them there, and the dev server serves the same
 * path. The decoder files carry no license header, and the bundler may drop
 * pdf.js's, hence the license files beside them.
 */
function pdfjsDecoders(): Plugin {
  const version = (JSON.parse(readFileSync(new URL("package.json", PDFJS), "utf8")) as { version: string }).version;
  const folder = `pdfjs/${version}/`;
  const files: Record<string, string> = {
    "jbig2_nowasm_fallback.js": "wasm/jbig2_nowasm_fallback.js",
    "openjpeg_nowasm_fallback.js": "wasm/openjpeg_nowasm_fallback.js",
    LICENSE: "LICENSE",
    LICENSE_JBIG2: "wasm/LICENSE_JBIG2",
    LICENSE_OPENJPEG: "wasm/LICENSE_OPENJPEG",
    LICENSE_PDFJS_JBIG2: "wasm/LICENSE_PDFJS_JBIG2",
    LICENSE_PDFJS_OPENJPEG: "wasm/LICENSE_PDFJS_OPENJPEG",
  };
  const read = (name: string) => readFileSync(new URL(files[name]!, PDFJS));
  return {
    name: "raccoon:pdfjs-decoders",
    configureServer(server) {
      server.middlewares.use(`/${folder}`, (req, res, next) => {
        const name = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
        if (!Object.hasOwn(files, name)) return next();
        res.setHeader("content-type", name.endsWith(".js") ? "text/javascript" : "text/plain; charset=utf-8");
        res.end(read(name));
      });
    },
    generateBundle() {
      for (const name of Object.keys(files)) this.emitFile({ type: "asset", fileName: `${folder}${name}`, source: read(name) });
    },
  };
}

const LAMEJS = new URL("./node_modules/@breezystack/lamejs/", import.meta.url);
const SOUND_LICENSES = new URL("./client/features/sound/upload/licenses/", import.meta.url);

/**
 * The MP3 encoder's license (docs/design/design-v1-sound.md 7.4).
 * `@breezystack/lamejs` is LGPL-3.0, and its package's LICENSE is only a
 * short note, so the full LGPL-3.0 and the GPL-3.0 it builds on are
 * committed beside the upload's code and written beside the encoder's
 * chunk, with a banner on the chunk naming the package, its version, its
 * license and its source. The library must stay a chunk of its own, so
 * whoever gets the app can swap in a changed library, which the AGPL
 * source and docs/development.md let them rebuild with. A build that
 * merged it with other code fails here rather than ship that way.
 *
 * The encoder loads inside the encode worker, which Vite bundles apart
 * from the page, so this plugin goes in `worker.plugins`.
 */
export function lameLicense(): Plugin {
  const pkg = JSON.parse(readFileSync(new URL("package.json", LAMEJS), "utf8")) as { name: string; version: string; license: string };
  const files: Record<string, URL> = {
    [`lamejs-${pkg.version}-LGPL-3.0.txt`]: new URL("LGPL-3.0.txt", SOUND_LICENSES),
    [`lamejs-${pkg.version}-GPL-3.0.txt`]: new URL("GPL-3.0.txt", SOUND_LICENSES),
    [`lamejs-${pkg.version}-LICENSE.txt`]: new URL("LICENSE", LAMEJS),
  };
  const banner = `/*! @license ${pkg.name} ${pkg.version}, ${pkg.license}. Source: https://github.com/shijinyu/lamejs and https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}. License texts beside this file: ${Object.keys(files).join(", ")}. */\n`;
  const isLame = (id: string) => id.includes("/@breezystack/lamejs/") || id.includes("/@breezystack+lamejs@");
  return {
    name: "raccoon:lame-license",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk" || !file.moduleIds.some(isLame)) continue;
        if (!file.moduleIds.every(isLame)) this.error(`${pkg.name} must stay a chunk of its own, but ${file.fileName} holds other modules too`);
        file.code = banner + file.code;
        // The banner is one line, so the map's lines all move down by one.
        const map = bundle[`${file.fileName}.map`];
        if (map?.type === "asset" && typeof map.source === "string") {
          const parsed = JSON.parse(map.source) as { mappings: string };
          parsed.mappings = `;${parsed.mappings}`;
          map.source = JSON.stringify(parsed);
        }
        const folder = file.fileName.slice(0, file.fileName.lastIndexOf("/") + 1);
        for (const [name, source] of Object.entries(files)) this.emitFile({ type: "asset", fileName: `${folder}${name}`, source: readFileSync(source) });
      }
    },
  };
}

/**
 * The SPA lives in client/, but public/ and the build output sit at the repo
 * root, where the server and the Dockerfile expect them. Vite resolves both
 * relative to `root`, so they are spelled out here or the icons and textures
 * would silently never reach dist/.
 *
 * In development the API and the WebSocket run in their own Node process
 * (scripts/dev.ts), and these proxies make the browser see one origin, the
 * same shape as production. That matters because the session cookie is
 * SameSite=Strict and the WebSocket upgrade checks Origin exactly.
 *
 * The proxies follow PORT, the variable the server listens on. scripts/dev.ts
 * hands the server and Vite the same environment, so a checkout that runs
 * its server on another port (a second workspace beside the first) proxies
 * to its own server. A fixed 3000 sent /api and /ws to whatever else was
 * listening there, which answered the room socket with errors of its own.
 */
const api = `127.0.0.1:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: "client",
  publicDir: "../public",
  plugins: [react(), devJsonImports(), pdfjsDecoders(), stableAssetMaps()],
  /*
   * Workers as ES modules, so a worker can load code by `import()`: the PDF
   * reader's worker loads its decoders and pdf.js only once it runs
   * (client/features/handouts/pdf/worker.ts), and the sound encode worker
   * its MP3 encoder, a chunk of its own with its license (`lameLicense`).
   */
  worker: { format: "es", plugins: () => [lameLicense()] },
  /*
   * The encoder loads only inside the encode worker, by `import()`, where
   * the dev server first meets it mid-session, bundles it then and reloads
   * the page, which loses a DM's file in the middle of converting it. So it
   * is bundled when the dev server starts.
   */
  optimizeDeps: { include: ["@breezystack/lamejs"] },
  resolve: {
    /*
     * react-konva's main entry imports all of Konva, Transformer and filters
     * included, which the board never uses. Its core entry is the same
     * components without that import, and client/canvas/konvaSetup.ts
     * registers the shapes the board draws.
     */
    alias: [{ find: /^react-konva$/, replacement: "react-konva/es/ReactKonvaCore.js" }],
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    /*
     * The SRD monster data is about 550 kB of JSON that gzips to 85 kB, in
     * its own chunk that only a DM opening the monster browser downloads,
     * and it passes Vite's default 500 kB on purpose. Konva and React's
     * reconciler for react-konva sit in a chunk of their own, which only a
     * room or a table display loads. The client needs zod at runtime too
     * (socket.ts checks every server message, store.ts every op), so it
     * stays in its own shared chunk. The limit sits just above the monster
     * data, so a chunk that grows past it still warns.
     */
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /*
         * A room and a table display share the canvas and most of the room's
         * code, so the bundler moves that code out of LiveRoom into a chunk
         * named after whichever module it meets first (once "closed", once
         * "XCardHost"). Naming it "room" keeps the build's size report
         * readable from one build to the next. pdf.js, which a DM's PDF
         * upload loads (client/features/handouts/pdf/render.ts), would be
         * named after the module that imports it, so it is named for itself.
         * Only the name changes: what goes in each chunk is the bundler's own
         * split.
         */
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.endsWith("/client/canvas/Stage.tsx"))
            ? "assets/room-[hash].js"
            : chunk.moduleIds.some((id) => id.includes("/node_modules/pdfjs-dist/") || id.includes("/pdfjs-dist@"))
              ? "assets/pdfjs-[hash].js"
              : "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://${api}`,
      "/healthz": `http://${api}`,
      "/ws": { target: `ws://${api}`, ws: true },
    },
  },
});
