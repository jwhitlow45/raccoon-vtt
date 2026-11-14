import net from "node:net";

/**
 * Ports (docs/design/design-v1-local-app.md 2 and 7). The app server's port
 * is free only when nothing listens on 0.0.0.0, 127.0.0.1 or ::1 there,
 * since `localhost` may resolve to ::1 first and the DM's browser would then
 * reach the other program. A bind alone can pass on macOS while another
 * program holds the wildcard address, so a connect is tried too.
 */

type Probe = { bind(host: string, port: number): Promise<"free" | "taken" | "absent">; connect(host: string, port: number): Promise<boolean> };

function bind(host: string, port: number): Promise<"free" | "taken" | "absent"> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      // A computer with IPv6 turned off has no ::1 to listen on, so nothing can be there.
      if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT") resolve("absent");
      else resolve("taken");
    });
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve("free")));
  });
}

function connect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export const realProbe: Probe = { bind, connect };

export async function portFree(port: number, probe: Probe = realProbe): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await probe.connect(host, port)) return false;
  }
  for (const host of ["127.0.0.1", "0.0.0.0", "::1"]) {
    if ((await probe.bind(host, port)) === "taken") return false;
  }
  return true;
}

/** The first free port from `from` up, or null when none is left. */
export async function firstFreePort(from: number, isFree: (port: number) => Promise<boolean> = portFree): Promise<number | null> {
  for (let port = from; port <= 65535; port++) {
    if (await isFree(port)) return port;
  }
  return null;
}

/** A port the system says is free on loopback now, for PostgreSQL (D-261113-084). */
export function loopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}
