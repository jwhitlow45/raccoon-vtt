import type { FastifyRequest } from "fastify";
import { HttpError } from "../auth/http.ts";
import type { Config } from "../config.ts";
import { ipv4Text, isLoopback, isPrivateV4, network, type LocalNetwork } from "./network.ts";

/**
 * What the desktop app's server lets in over plain HTTP on a network
 * (docs/design/design-v1-local-app.md 6, D-261113-055 and 081). A hosted
 * server keeps its one exact origin and none of the rest.
 */

export type OriginPolicy = {
  /** Whether an unsafe request or a WebSocket upgrade with this Origin comes from one of the app's own pages. */
  originAllowed(origin: string | undefined): boolean;
  /** Whether a request names one of the app's own hosts. A domain re-pointed at this computer (DNS rebinding) does not. */
  hostAllowed(host: string | undefined): boolean;
};

export type PolicyConfig = Pick<Config, "local" | "publicOrigin" | "PORT" | "HOST">;

/**
 * Hosted, the one public origin, as before. Local, `localhost` and
 * `127.0.0.1` on PORT, and each of this computer's private addresses while
 * HOST is 0.0.0.0, read at each check so a new address joins at once
 * (design 6.2). `Origin: null` is never allowed: any sandboxed page sends it.
 */
export function originPolicy(config: PolicyConfig, net: Pick<LocalNetwork, "localAddresses"> = network): OriginPolicy {
  if (!config.local) {
    return { originAllowed: (origin) => origin === config.publicOrigin, hostAllowed: () => true };
  }
  const hosts = (): Set<string> => {
    const names = ["localhost", "127.0.0.1", ...(config.HOST === "0.0.0.0" ? net.localAddresses() : [])];
    // A browser leaves the port out of Host and Origin when it is http's own.
    return new Set(names.map((name) => (config.PORT === 80 ? name : `${name}:${config.PORT}`)));
  };
  return {
    originAllowed: (origin) => origin !== undefined && origin.startsWith("http://") && hosts().has(origin.slice("http://".length)),
    hostAllowed: (host) => host !== undefined && hosts().has(host.toLowerCase()),
  };
}

/**
 * Whether a peer may connect at all: loopback or a private IPv4 address
 * (design 6). A forwarded port, a public address, CGNAT and Tailscale's
 * 100.64.0.0/10, and link-local addresses are not.
 */
export function privatePeer(address: string | undefined): boolean {
  const v4 = ipv4Text(address);
  return v4 !== null && (isLoopback(v4) || isPrivateV4(v4));
}

/**
 * Closes a connection from outside the private ranges before HTTP reads a
 * byte of it. The app server adds it first among its `connection`
 * listeners in local mode.
 */
export function dropForeignPeer(socket: { readonly remoteAddress?: string | undefined; destroy(): unknown }): void {
  if (!privatePeer(socket.remoteAddress)) socket.destroy();
}

/**
 * Whether the request comes from the computer running the app, by the
 * socket's own address. Never by a header, and not by this computer's
 * network address either, since a request to it can come from anywhere
 * that address is reachable (D-261113-081).
 */
export function isHostComputer(req: Pick<FastifyRequest, "socket">): boolean {
  return isLoopback(req.socket.remoteAddress);
}

/** Whether an address is this computer's: loopback or one of its own network addresses (D-261113-095). */
export function thisComputer(address: string, net: Pick<LocalNetwork, "localAddresses"> = network): boolean {
  if (isLoopback(address)) return true;
  const v4 = ipv4Text(address);
  return v4 !== null && net.localAddresses().includes(v4);
}

/**
 * The one guard room creation and room import call first: in local mode
 * only the host computer makes rooms, so a guest on the network can neither
 * fill the disk nor tie up the processor with an import (design 6). Hosted,
 * it does nothing.
 */
export function requireHostComputer(config: Pick<Config, "local">, req: Pick<FastifyRequest, "socket">): void {
  if (config.local && !isHostComputer(req)) throw new HttpError(403, "host_only");
}
