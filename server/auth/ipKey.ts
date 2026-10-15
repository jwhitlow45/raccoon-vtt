import ipaddr from "ipaddr.js";

/**
 * The form of a client address that limits count against.
 *
 * An IPv6 home connection or a cheap server is handed a whole /64, which is
 * 2^64 addresses to rotate through, so a per-address limit on IPv6 limits
 * nothing. Every IPv6 address is therefore counted as its /64, which is the
 * smallest block one subscriber normally gets. IPv4, including IPv4 written
 * as IPv6 (::ffff:203.0.113.9), is counted per address. Anything that does
 * not parse is used as it is.
 *
 * Rooms store this form as `created_ip` too, so a per-creator limit on
 * loaded rooms groups the same way.
 */
export function ipKey(ip: string): string {
  if (!ipaddr.isValid(ip)) return ip;
  const addr = ipaddr.process(ip);
  if (addr instanceof ipaddr.IPv4) return addr.toString();
  const prefix = addr.parts.slice(0, 4).map((part) => part.toString(16));
  return `${prefix.join(":")}::/64`;
}
