import type { FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { isHostComputer } from "./guard.ts";
import { ipv4Text, type LocalNetwork } from "./network.ts";

/**
 * GET /api/config's `local` part, answered per request, as client/lib/api.ts
 * types it (`LocalServerConfig`, docs/design/design-v1-local-app.md 4 and 5).
 * - `shareOrigin`: the address every link for another device names, while
 *   players on the network can join and this computer has one to show.
 * - `createHere`: this device is the computer running the app, the only one
 *   that makes and imports rooms.
 * - `hostPage`: that computer's own page, when it opened the network address
 *   instead, so Home can send it there.
 */
export type LocalApiConfig = { shareOrigin: string | null; createHere: boolean; hostPage: string | null };

export async function localApiConfig(config: Pick<Config, "HOST" | "PORT">, net: LocalNetwork, req: Pick<FastifyRequest, "socket">): Promise<LocalApiConfig> {
  const primary = config.HOST === "0.0.0.0" ? await net.primaryAddress() : null;
  const createHere = isHostComputer(req);
  const peer = ipv4Text(req.socket.remoteAddress);
  const ownAddress = !createHere && peer !== null && net.localAddresses().includes(peer);
  return {
    shareOrigin: primary === null ? null : originOf(primary, config.PORT),
    createHere,
    hostPage: ownAddress ? `${originOf("localhost", config.PORT)}/` : null,
  };
}

/** As a browser writes it, so the port is left out when it is http's own. */
function originOf(host: string, port: number): string {
  return new URL(`http://${host}:${port}`).origin;
}
