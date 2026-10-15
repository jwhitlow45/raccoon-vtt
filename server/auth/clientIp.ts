import type { FastifyRequest } from "fastify";

/**
 * The address a request came from, and the only place that decides it. Every
 * limiter keys on this, because behind a proxy or tunnel the socket address
 * is always that proxy's container, so a limiter on the default key would
 * throttle the whole site as one client (design section 10.3).
 *
 * Cloudflare sets CF-Connecting-IP itself and overwrites whatever the client
 * sent, so behind Cloudflare it is exact, and another proxy can be set to
 * overwrite it the same way. That is only true while the origin is reachable
 * through that front end alone, which is why trusting it is
 * an explicit setting rather than a default. Without it, the socket address.
 */
export function clientIp(req: FastifyRequest, trustCfConnectingIp: boolean): string {
  let ip = req.socket.remoteAddress ?? "";
  if (trustCfConnectingIp) {
    const header = req.headers["cf-connecting-ip"];
    const value = Array.isArray(header) ? header[0] : header;
    if (value) ip = value;
  }
  // Cut to the longest an IPv6 address can be written, so a forged header
  // cannot make limiter keys as long as the sender likes.
  return ip.trim().slice(0, 45) || "unknown";
}
