import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SearchResult, SearchSource } from "#shared/protocol.ts";
import { AssetError, isAssetError } from "../assets/errors.ts";
import type { GrantContext } from "../auth/types.ts";
import { clientIp } from "../auth/clientIp.ts";
import { ipKey } from "../auth/ipKey.ts";

/**
 * `POST /api/rooms/:id/image-search` (design section 11.3 and
 * docs/design-v1-dm-tools.md 3.13). A POST because it spends quota and
 * writes the cache. The answer names its source, so the picker can say
 * where the results came from and credit Openverse's.
 *
 * Google Images through SerpApi comes first when SERPAPI_KEY is set. When
 * SerpApi cannot answer (no key, the account under its floor, this hour's
 * cap, or the room's or the address's SerpApi quota spent, which are its
 * 429s), Openverse answers instead, so a server without a key still has
 * search. `source: "openverse"` asks Openverse on purpose, for a DM who
 * wants openly licensed art. SerpApi's other failures are not about quota,
 * so they are answered as they are, and the next search tries Google again.
 *
 * Quota refusals are 429 with a code naming the budget (`quota_member`,
 * `quota_room`, `quota_ip`, `quota_global`), so the picker can say which one
 * ran out and offer upload, paste and URL instead. Once Openverse has been
 * tried, a refusal is always Openverse's, since SerpApi's lead to it.
 */
const SearchBody = z.object({ q: z.string().min(1).max(200), source: z.enum(["openverse"]).optional() });

export type SearchAnswer = { results: SearchResult[]; source: SearchSource };

export async function registerSearchRoutes(
  scope: FastifyInstance,
  deps: { requireGrant: (req: FastifyRequest, reply: FastifyReply, roomId: string) => Promise<GrantContext> },
): Promise<void> {
  const trustCf = scope.config.TRUST_CF_CONNECTING_IP === "1";

  scope.post<{ Params: { id: string } }>("/api/rooms/:id/image-search", async (req, reply): Promise<SearchAnswer> => {
    const roomId = req.params.id;
    const grant = await deps.requireGrant(req, reply, roomId);
    const body = SearchBody.safeParse(req.body);
    if (!body.success) throw new AssetError(400, "bad_query");
    const room = await scope.assets.roomInfo(roomId);
    if (!room) throw new AssetError(404, "not_found");
    // Counted as the limits count every address: an IPv6 /64 is one client.
    const ip = ipKey(clientIp(req, trustCf));

    const google = scope.assets.search;
    if (google && body.data.source !== "openverse") {
      try {
        return { results: await google.search(body.data.q, { roomId, roomCreatedAt: room.createdAt, ip }), source: "google" };
      } catch (err) {
        if (!(isAssetError(err) && err.status === 429)) throw err;
      }
    }
    try {
      const results = await scope.assets.openverse.search(body.data.q, { roomId, memberId: grant.memberId, ip });
      return { results, source: "openverse" };
    } catch (err) {
      // The cause is a status line openverse.ts wrote, never a request or a
      // credential, and it is the only trace of a broken registration.
      if (isAssetError(err) && err.code === "search_failed") {
        req.log.warn({ reason: err.cause instanceof Error ? err.cause.message : undefined }, "Openverse search failed");
      }
      throw err;
    }
  });
}
