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
  plugins: [react(), devJsonImports()],
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
         * readable from one build to the next. Only the name changes: what
         * goes in each chunk is the bundler's own split.
         */
        chunkFileNames: (chunk) => (chunk.moduleIds.some((id) => id.endsWith("/client/canvas/Stage.tsx")) ? "assets/room-[hash].js" : "assets/[name]-[hash].js"),
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
