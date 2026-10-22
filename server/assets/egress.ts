import dns from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, Pool, ProxyAgent, type Dispatcher } from "undici";
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

/** How long a proxy may take to answer a CONNECT. */
const CONNECT_ANSWER_MS = 10_000;

/**
 * A ProxyAgent whose own Pool, which carries only the CONNECTs to the proxy
 * and never a tunnel's traffic, waits at most `connectAnswerMs` for the
 * proxy's answer. Squid's limits (docker/squid.conf) bound a connect it
 * tries and its search for a path, but not a CONNECT it takes and never
 * answers, or a DNS lookup that stalls. undici's own default there is five
 * minutes, and every request to that host queues behind it.
 */
function proxyAgent(uri: string, connectAnswerMs: number): ProxyAgent {
  return new ProxyAgent({ uri, clientFactory: (origin, options) => new Pool(origin, { ...options, headersTimeout: connectAnswerMs }) });
}

export function createEgress(config: Pick<Config, "production" | "EGRESS_PUBLIC_PROXY" | "EGRESS_STRICT_PROXY">, opts: { connectAnswerMs?: number } = {}): Egress {
  if (config.production && (!config.EGRESS_PUBLIC_PROXY || !config.EGRESS_STRICT_PROXY)) {
    throw new Error("Production needs EGRESS_PUBLIC_PROXY and EGRESS_STRICT_PROXY.");
  }
  const connectAnswerMs = opts.connectAnswerMs ?? CONNECT_ANSWER_MS;
  let direct: Agent | undefined;
  const guarded = (): Agent => (direct ??= guardedAgent());
  const pub = config.EGRESS_PUBLIC_PROXY ? proxyAgent(config.EGRESS_PUBLIC_PROXY, connectAnswerMs) : guarded();
  const strict = config.EGRESS_STRICT_PROXY ? proxyAgent(config.EGRESS_STRICT_PROXY, connectAnswerMs) : guarded();
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

/**
 * A pending request, ended by its signal however far it got. undici aborts
 * a request only once it holds a connection, and a proxy that keeps its
 * CONNECT open never gives it one, so a caller would wait for as long as the
 * proxy takes to give up, holding whatever slot it took for the fetch. A
 * request that answers after the signal is thrown away. Every `request()`
 * through either port goes through this.
 */
export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal, discard: (late: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      pending.then(discard, () => undefined);
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
