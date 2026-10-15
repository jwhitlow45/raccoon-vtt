import dns from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { Config } from "../config.ts";

/**
 * The two ways out (design section 10.6), each an explicit undici dispatcher
 * so the port a call uses is visible at its call site and nothing can go out
 * through environment proxy variables by accident.
 *
 * - `strict` reaches serpapi.com and api.openverse.org only (squid port
 *   3128), for the two image searches.
 * - `public` reaches any public host on 443 (squid port 3129), for URL
 *   imports.
 *
 * Production always goes through squid, and config.ts refuses to boot
 * without both proxy URLs. In development without squid both fall back to a
 * direct connection whose DNS lookup refuses every non-unicast address, so a
 * URL import on a development machine cannot reach the router or a local
 * service either.
 * TLS verification stays on in every case.
 */
export type Egress = { public: Dispatcher; strict: Dispatcher; close(): Promise<void> };

export function createEgress(config: Pick<Config, "production" | "EGRESS_PUBLIC_PROXY" | "EGRESS_STRICT_PROXY">): Egress {
  if (config.production && (!config.EGRESS_PUBLIC_PROXY || !config.EGRESS_STRICT_PROXY)) {
    throw new Error("Production needs EGRESS_PUBLIC_PROXY and EGRESS_STRICT_PROXY.");
  }
  let direct: Agent | undefined;
  const guarded = (): Agent => (direct ??= guardedAgent());
  const pub = config.EGRESS_PUBLIC_PROXY ? new ProxyAgent({ uri: config.EGRESS_PUBLIC_PROXY }) : guarded();
  const strict = config.EGRESS_STRICT_PROXY ? new ProxyAgent({ uri: config.EGRESS_STRICT_PROXY }) : guarded();
  return {
    public: pub,
    strict,
    async close() {
      await Promise.allSettled([...new Set([pub, strict])].map((d) => d.close()));
    },
  };
}

/** True only for globally routable unicast addresses. IPv4-mapped IPv6 is judged as the IPv4 it carries. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === "unicast";
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, options: LookupOptions & { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * A `net.connect` lookup that resolves every address of the host and refuses
 * the connection if any of them is not public unicast. Checking all of them,
 * not just the first, matters because Node may try each in turn (happy
 * eyeballs). Node skips the lookup for IP-literal hosts, which is why
 * fetchPublicImage refuses those before connecting.
 */
export function guardedLookup(resolve: Resolver = dns.lookup as unknown as Resolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
        const blocked: NodeJS.ErrnoException = new Error(`refusing to connect to a non-public address for ${hostname}`);
        blocked.code = "EBLOCKED";
        return callback(blocked, []);
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    });
  };
}

export function guardedAgent(resolve?: Resolver): Agent {
  return new Agent({ connect: { lookup: guardedLookup(resolve) } });
}
