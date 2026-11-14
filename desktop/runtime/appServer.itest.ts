import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isAlive } from "./processInfo.ts";
import { createRoom, supervisorDbUrl } from "./testing/dataFixture.ts";
import { startSupervisor } from "./testing/supervisorProcess.ts";

/**
 * The supervisor with the real app server, server/main.ts in local mode
 * (docs/design/design-v1-local-app.md 2, 4 and 8.6): it starts healthy with
 * the environment the supervisor builds from nothing, answers on loopback
 * only with the switch off, lists the computer's rooms and makes a new DM
 * link through scripts/admin.ts, moves to 0.0.0.0 and back with the switch
 * where the network allows it, and stops over its channel with nothing left
 * running.
 */

const PORT = 40402;
const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("the real app server runs under the supervisor, and stops cleanly over its channel", { timeout: 180_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), "rvtt-appserver-"));
  dirs.push(data);
  const sup = startSupervisor({ data, port: PORT, realServer: true });
  try {
    const running = await sup.waitFor("running", (s) => s.state === "running", 120_000);
    assert.equal(running.host, "127.0.0.1");
    assert.equal(running.network, "off");

    const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(health.status, 200);
    const config = (await (await fetch(`http://localhost:${PORT}/api/config`)).json()) as { local: { createHere: boolean } | null };
    assert.equal(config.local?.createHere, true, "local mode, and this computer may make rooms");
    // A name the server does not answer to is refused before HTTP (DNS rebinding).
    const foreign = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", headers: { host: `evil.example:${PORT}` } }, (res) => resolve(res.statusCode)).on("error", reject);
    });
    assert.equal(foreign, 421);

    const url = await supervisorDbUrl(data);
    const roomId = await createRoom(url, "Under the supervisor");
    const listed = await sup.command({ type: "listRooms" });
    assert.ok(listed.ok);
    const rooms = (listed.value as { rooms: Array<{ id: string; name: string }> }).rooms;
    assert.deepEqual(
      rooms.map((r) => [r.id, r.name]),
      [[roomId, "Under the supervisor"]],
    );
    const link = await sup.command({ type: "newDmLink", roomId });
    assert.ok(link.ok);
    assert.match((link.value as { link: string }).link, new RegExp(`^http://localhost:${PORT}/r/\\w{4}-\\w{4}#dm=`));

    // The switch moves the server to every address and back, restarting it each time. Windows opens
    // it only on a network marked Private (design 6), and a hosted runner's network is Public.
    assert.ok((await sup.command({ type: "setNetworkPlay", on: true })).ok);
    const on = await sup.waitFor("the switch on, with the network's reach", (s) => s.state === "running" && s.settings.networkPlay && s.network !== "off" && s.network !== "unknown");
    const opens = process.platform !== "win32" || on.network === "open";
    await sup.waitFor(opens ? "the server on every address" : "the server kept on loopback", (s) => s.state === "running" && s.host === (opens ? "0.0.0.0" : "127.0.0.1"));
    assert.ok((await sup.command({ type: "setNetworkPlay", on: false })).ok);
    await sup.waitFor("the server on loopback again", (s) => s.state === "running" && s.host === "127.0.0.1");
    assert.equal(JSON.parse(await readFile(join(data, "settings.json"), "utf8")).networkPlay, false);

    const postmaster = Number((await readFile(join(data, "postgres", "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);
    assert.equal(await sup.stop(), 0);
    assert.equal(isAlive(postmaster), false, "PostgreSQL is stopped");
    const serverLog = await readFile(join(data, "logs", "server.log"), "utf8");
    assert.match(serverLog, /shutting down/, "the server ran its own graceful shutdown");
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/healthz`), "nothing listens after the stop");
  } finally {
    // A clean stop, so a failure leaves no PostgreSQL holding the data folder the after hook deletes.
    await sup.stop().catch(() => undefined);
  }
});
