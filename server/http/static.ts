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

/**
 * The built SPA from `dist`. Client-side routes such as /r/K7QH-2MXA all
 * load the same page, except under /api/, /ws and /game-icons/: an icon key
 * the build does not know answers 404, so the client draws initials instead
 * of trying to read the page as an icon.
 *
 * The rest of the build is served one route per file, found at boot. The
 * 4,180 icons get one wildcard route of their own instead: a route each
 * made boot about 0.4 s slower and held about 50 MB more heap for routes
 * nothing else needs.
 */
export async function registerStatic(app: FastifyInstance, dist: string): Promise<void> {
  await app.register(fastifyStatic, { root: dist, wildcard: false, globIgnore: ["game-icons/**"] });
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
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/ws") && !req.url.startsWith("/game-icons/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" satisfies ApiErrorCode });
  });
}
