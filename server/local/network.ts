import dgram from "node:dgram";
import os from "node:os";

/**
 * This computer's addresses on its networks, for the desktop app
 * (docs/design/design-v1-local-app.md 4 and 7). The app server builds its
 * Host and Origin lists from `localAddresses()`, and the address players are
 * shown is `primaryAddress()`. The supervisor imports this module too, so it
 * uses Node's built-ins alone.
 */

export type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export type NetworkSource = {
  interfaces?: () => Interfaces;
  now?: () => number;
  /** The address the default route would send from, or null when there is no default route. */
  routeAddress?: () => Promise<string | null>;
};

export type LocalNetwork = {
  /** Every private IPv4 address this computer holds on a network, in the system's order. */
  localAddresses(): string[];
  /** The address to show players, or null when no network interface qualifies. */
  primaryAddress(): Promise<string | null>;
};

/** How long a reading of the interfaces and the route stands, so a page asking every few seconds costs nothing. */
export const NETWORK_CACHE_MS = 5_000;

/** An address in TEST-NET-1 (RFC 5737), which nothing answers. Connecting a UDP socket to it sends no packet. */
const ROUTE_PROBE = "192.0.2.1";

/** The dotted-quad IPv4 address as a number, also from its IPv4-mapped IPv6 form, else null. */
export function ipv4Number(address: string | undefined): number | null {
  if (address === undefined) return null;
  const text = address.toLowerCase().startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** The IPv4 address in dotted-quad form, also from its IPv4-mapped IPv6 form, else null. */
export function ipv4Text(address: string | undefined): string | null {
  const n = ipv4Number(address);
  if (n === null) return null;
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

function inBlock(n: number, base: number, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(base / size);
}

const TEN = 10 * 2 ** 24;
const ONE_SEVENTY_TWO = 172 * 2 ** 24 + 16 * 2 ** 16;
const ONE_NINETY_TWO = 192 * 2 ** 24 + 168 * 2 ** 16;
const LOOPBACK = 127 * 2 ** 24;

/** In 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16 (RFC 1918). */
export function isPrivateV4(address: string | undefined): boolean {
  const n = ipv4Number(address);
  return n !== null && (inBlock(n, TEN, 8) || inBlock(n, ONE_SEVENTY_TWO, 12) || inBlock(n, ONE_NINETY_TWO, 16));
}

/** In 127/8, or IPv6's ::1. */
export function isLoopback(address: string | undefined): boolean {
  if (address === "::1") return true;
  const n = ipv4Number(address);
  return n !== null && inBlock(n, LOOPBACK, 8);
}

/**
 * Names of interfaces that lead somewhere other than the network players
 * are on: container and virtual machine bridges, and VPN and overlay
 * tunnels. The design names the Linux and macOS prefixes. Windows shows
 * friendly names ("vEthernet (WSL)", "VMware Network Adapter VMnet8",
 * "VirtualBox Host-Only Network", "ZeroTier One [...]"), so those are
 * matched by the words in them. Linux's libvirt, LXC, LXD, Podman and CNI
 * bridges and Parallels' vnic have MAC addresses of their own. macOS's
 * bridge interfaces stay: bridge0 is the Thunderbolt Bridge, and bridge100
 * and up serve Internet Sharing, whose devices may be the players, as well
 * as virtual machines, which no name tells apart.
 */
const OTHER_NETWORK = /^(docker|br-|veth|vethernet|vmnet|vboxnet|utun|tun|tap|wg|ppp|ipsec|tailscale|zt|virbr|lxcbr|lxdbr|podman|cni|vnic)|vmware|virtualbox|zerotier|wireguard|wintun|tap-windows/i;

/**
 * Whether an interface may hold the address shown to players (D-261113-085).
 * A tunnel often reports an all-zero MAC address, which catches one with a
 * name the list misses. The names still rule out a virtual adapter that has
 * a MAC address of its own.
 */
export function eligible(name: string, info: Pick<os.NetworkInterfaceInfo, "mac">): boolean {
  return !OTHER_NETWORK.test(name) && info.mac !== "00:00:00:00:00:00";
}

function privateEntries(interfaces: Interfaces): Array<{ name: string; info: os.NetworkInterfaceInfo }> {
  const found: Array<{ name: string; info: os.NetworkInterfaceInfo }> = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && isPrivateV4(info.address)) found.push({ name, info });
    }
  }
  return found;
}

/**
 * The address the system would send from on its default route. Connecting
 * a UDP socket only picks the route and its source address, so nothing
 * leaves the computer. No default route (offline) is an error, and null.
 */
export function defaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.unref();
    let settled = false;
    const done = (address: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed by its error.
      }
      resolve(address);
    };
    const timer = setTimeout(() => done(null), 1_000);
    timer.unref();
    socket.on("error", () => done(null));
    socket.connect(9, ROUTE_PROBE, () => {
      try {
        done(socket.address().address);
      } catch {
        done(null);
      }
    });
  });
}

export function localNetwork(source: NetworkSource = {}): LocalNetwork {
  const readInterfaces = source.interfaces ?? os.networkInterfaces;
  const now = source.now ?? Date.now;
  const readRoute = source.routeAddress ?? defaultRouteAddress;
  let interfaces: { at: number; value: Interfaces } | null = null;
  let route: { at: number; value: Promise<string | null> } | null = null;

  const current = (): Interfaces => {
    const t = now();
    if (!interfaces || t - interfaces.at >= NETWORK_CACHE_MS) interfaces = { at: t, value: readInterfaces() };
    return interfaces.value;
  };
  const routed = (): Promise<string | null> => {
    const t = now();
    if (!route || t - route.at >= NETWORK_CACHE_MS) route = { at: t, value: readRoute().catch(() => null) };
    return route.value;
  };
  const localAddresses = (): string[] => [...new Set(privateEntries(current()).map((e) => e.info.address))];

  return {
    localAddresses,
    /**
     * The default route's address when its interface is eligible and the
     * address is one of `localAddresses()`, else the first eligible private
     * address, else null. So a full-tunnel VPN or a public default route
     * never becomes the share address, and the share address is always one
     * the Host list accepts (D-261113-085).
     */
    async primaryAddress() {
      const via = await routed();
      const entries = privateEntries(current());
      if (via !== null && entries.some((e) => e.info.address === via && eligible(e.name, e.info))) return via;
      return entries.find((e) => eligible(e.name, e.info))?.info.address ?? null;
    },
  };
}

/** The computer's own network, read live. */
export const network: LocalNetwork = localNetwork();
