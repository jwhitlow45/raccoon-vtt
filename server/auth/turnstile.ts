import { Agent, type Dispatcher, fetch, ProxyAgent } from "undici";
import type { Config } from "../config.ts";

/**
 * Cloudflare Turnstile on room creation and import, and on password joins to
 * a room that has seen many wrong passwords, when TURNSTILE_SECRET is set
 * (design sections 10.1 and 10.3).
 *
 * The verification call goes through the strict egress port, which allows
 * challenges.cloudflare.com and nothing else (design section 10.6). The
 * dispatcher is always explicit, never the environment's proxy variables, so
 * this call cannot silently go direct in production. Development without
 * squid connects directly through a plain Agent.
 */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_MAX = 2048;

export type TurnstileResult = "ok" | "failed" | "unavailable";

let dispatcher: { key: string; value: Dispatcher } | undefined;
let testDispatcher: Dispatcher | null = null;

/** Sends verification to a stand-in for Cloudflare instead. Tests only. */
export function setTurnstileDispatcherForTests(value: Dispatcher | null): void {
  testDispatcher = value;
}

function dispatcherFor(proxy: string | undefined): Dispatcher {
  const key = proxy ?? "direct";
  if (dispatcher?.key !== key) {
    dispatcher = { key, value: proxy ? new ProxyAgent(proxy) : new Agent() };
  }
  return dispatcher.value;
}

export function turnstileEnabled(config: Pick<Config, "TURNSTILE_SECRET">): boolean {
  return Boolean(config.TURNSTILE_SECRET);
}

/**
 * `ip` is the visitor's own address from clientIp(), never the /64 that the
 * limits count by: Cloudflare compares it with the address that solved the
 * challenge.
 */
export async function verifyTurnstile(
  config: Pick<Config, "TURNSTILE_SECRET" | "EGRESS_STRICT_PROXY" | "production" | "publicOrigin">,
  token: string | undefined,
  ip: string,
): Promise<TurnstileResult> {
  const secret = config.TURNSTILE_SECRET;
  if (!secret) return "ok";
  if (!token || token.length > TOKEN_MAX) return "failed";
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      dispatcher: testDispatcher ?? dispatcherFor(config.EGRESS_STRICT_PROXY),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "unavailable";
    const data = (await res.json()) as { success?: unknown; hostname?: unknown };
    if (data.success !== true) return "failed";
    // Cloudflare's advice: a token solved on another site that shares this
    // widget must not count here. Only in production, because Cloudflare's
    // test keys always report a placeholder hostname.
    if (config.production && data.hostname !== new URL(config.publicOrigin).hostname) return "failed";
    return "ok";
  } catch {
    // Fail closed: nothing Turnstile guards goes ahead (a new room, an import,
    // a challenged join) while Cloudflare cannot vouch for it.
    return "unavailable";
  }
}
