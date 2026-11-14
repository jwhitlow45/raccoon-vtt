import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * client/globals.css names the interface font by an absolute path that the
 * web app's server answers (`/fonts/...`). The window loads from a file, so
 * the same files are named relative to the stylesheet and the build hashes
 * and copies them beside the page. Nothing else of `public/` comes along.
 */
function relativeFonts(): Plugin {
  return {
    name: "raccoon:window-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0]!.endsWith("/client/globals.css")) return null;
      return code.replaceAll('url("/fonts/', 'url("../public/fonts/');
    },
  };
}

/**
 * The window's page (design 9) is built apart from the web app. Its base is
 * relative so the shell can load it from a file or from its own scheme. The
 * output goes to desktop/out/window, which the shell packs.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  publicDir: false,
  plugins: [relativeFonts(), react()],
  build: {
    outDir: new URL("../out/window", import.meta.url).pathname,
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { port: 5174, strictPort: true },
});
