import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { ApiErrorCode } from "#shared/apiErrors.ts";

/**
 * The token icons' folder (docs/design-v1-dm-tools.md 3.12). Its name holds
 * the first 8 characters of the pinned commit, so a new pin is a new URL
 * and a file under one name never changes: browsers may keep each icon for
 * good and never ask again, which is what lets a device that fetched an
 * icon once draw it offline.
 */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** A font file named for its hash, such as fonts/InterVariable-8a540aa8.woff2, by its path on disk. */
const FONT_FILE = /[/\\]fonts[/\\][^/\\]+-[0-9a-f]{8}\.woff2$/;

/**
 * The built SPA from `dist`. Client-side routes such as /r/K7QH-2MXA all
 * load the same page, except under /api/, /ws, /game-icons/ and /starter/:
 * an icon key the build does not know answers 404, so the client draws
 * initials instead of trying to read the page as an icon, and a starter
 * thumbnail that is gone shows as missing rather than as a page.
 *
 * The rest of the build is served one route per file, found at boot. The
 * 4,180 icons get one wildcard route of their own instead: a route each
 * made boot about 0.4 s slower and held about 50 MB more heap for routes
 * nothing else needs. The starter packs' files and thumbnails, about a
 * thousand (docs/design-v1-starter-art.md 8), get one too. They keep the
 * default revalidation: a rebuilt work keeps its name, so a browser must
 * ask again.
 *
 * The interface font's files are cached for good too: each name holds its
 * content's hash (client/lib/interFont.ts). Revalidated, a reload's preload
 * of the font asked the server again while the page drew from the copy the
 * browser held, and Chrome warned that the preload went unused.
 */
export async function registerStatic(app: FastifyInstance, dist: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dist,
    wildcard: false,
    globIgnore: ["game-icons/**", "starter/**"],
    setHeaders(reply, path) {
      if (FONT_FILE.test(path)) reply.header("cache-control", IMMUTABLE);
    },
  });
  await app.register(fastifyStatic, {
    root: join(dist, "game-icons"),
    prefix: "/game-icons/",
    wildcard: true,
    // The first registration already gave replies sendFile.
    decorateReply: false,
    setHeaders(reply) {
      reply.header("cache-control", IMMUTABLE);
    },
  });
  // A build from before the starter packs has no folder, and the plugin warns at boot about a root that does not exist.
  if (existsSync(join(dist, "starter"))) {
    await app.register(fastifyStatic, {
      root: join(dist, "starter"),
      prefix: "/starter/",
      wildcard: true,
      decorateReply: false,
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/ws") && !req.url.startsWith("/game-icons/") && !req.url.startsWith("/starter/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" satisfies ApiErrorCode });
  });
}
