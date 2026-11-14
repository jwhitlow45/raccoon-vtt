import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { firstFreePort, loopbackPort, portFree } from "./ports.ts";

/**
 * The app server's port is free only when nothing listens on 127.0.0.1,
 * 0.0.0.0 or ::1 there (docs/design/design-v1-local-app.md 7), since
 * `localhost` may resolve to ::1 first.
 */

function listenOn(host: string, port = 0): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return address.port;
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function hasIpv6Loopback(): Promise<boolean> {
  try {
    await close(await listenOn("::1"));
    return true;
  } catch {
    return false;
  }
}

test("a port nothing listens on is free", async () => {
  assert.equal(await portFree(await loopbackPort()), true);
});

test("a listener on 127.0.0.1 alone takes the port", async () => {
  const server = await listenOn("127.0.0.1");
  try {
    assert.equal(await portFree(portOf(server)), false);
  } finally {
    await close(server);
  }
});

test("a listener on 0.0.0.0 alone takes the port", async () => {
  const server = await listenOn("0.0.0.0");
  try {
    assert.equal(await portFree(portOf(server)), false);
  } finally {
    await close(server);
  }
});

test("a listener on ::1 alone takes the port", async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip("this machine has no IPv6 loopback, so nothing can listen on ::1");
    return;
  }
  const server = await listenOn("::1");
  try {
    assert.equal(await portFree(portOf(server)), false);
  } finally {
    await close(server);
  }
});

/**
 * A system may let a bind through while another program listens (Windows
 * lets a specific address be bound over a wildcard one), so a connect that
 * answers counts on its own, and each check covers ::1.
 */
test("either check alone, on any of the three addresses, takes the port", async () => {
  const probe = (answers: string[], refused: string[]) => ({
    connect: async (host: string) => answers.includes(host),
    bind: async (host: string) => (refused.includes(host) ? ("taken" as const) : ("free" as const)),
  });
  assert.equal(await portFree(3170, probe([], [])), true);
  for (const host of ["127.0.0.1", "::1"]) assert.equal(await portFree(3170, probe([host], [])), false, `a connect to ${host} answers`);
  for (const host of ["127.0.0.1", "0.0.0.0", "::1"]) assert.equal(await portFree(3170, probe([], [host])), false, `a bind on ${host} is refused`);
  // A computer with no IPv6 has no ::1 for anything to hold.
  assert.equal(await portFree(3170, { connect: async () => false, bind: async (host) => (host === "::1" ? "absent" : "free") }), true);
});

test("firstFreePort skips the ports that are taken", async () => {
  const taken = new Set([3170, 3171, 3173]);
  assert.equal(await firstFreePort(3170, async (p) => !taken.has(p)), 3172);
  assert.equal(await firstFreePort(65535, async () => false), null);
});
