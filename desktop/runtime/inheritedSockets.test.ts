import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { closeInheritedSockets, type FdTable } from "./inheritedSockets.ts";

const MODULE = new URL("./inheritedSockets.ts", import.meta.url).href;

test("only sockets past the standard streams and the IPC channel are closed, and only on Linux", () => {
  const table = (targets: Record<number, string | null>, refuse: number[] = []): FdTable & { closed: number[] } => {
    const closed: number[] = [];
    return {
      closed,
      list: () => [...Object.keys(targets), "x"],
      target: (fd) => targets[fd] ?? null,
      close: (fd) => {
        if (refuse.includes(fd)) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        closed.push(fd);
      },
    };
  };
  const fds = { 0: "/dev/null", 1: "socket:[11]", 2: "socket:[12]", 3: "socket:[13]", 4: "anon_inode:[eventpoll]", 7: "socket:[17]", 8: "pipe:[18]", 9: "/opt/x/icudtl.dat", 12: "socket:[22]", 13: null };
  const linux = table(fds, [12]);
  assert.deepEqual(closeInheritedSockets("linux", linux), [7], "a socket that closed since the listing is no failure");
  assert.deepEqual(linux.closed, [7]);
  for (const platform of ["darwin", "win32"] as const) {
    const other = table(fds);
    assert.deepEqual(closeInheritedSockets(platform, other), []);
    assert.deepEqual(other.closed, []);
  }
});

test("Linux: a child closes the socket it inherited past its IPC channel, and its channel still works", { skip: process.platform !== "linux" && "/proc/self/fd is Linux's" }, async () => {
  const script = [
    `import { readdirSync, readlinkSync } from "node:fs";`,
    `import { closeInheritedSockets } from ${JSON.stringify(MODULE)};`,
    "const closed = closeInheritedSockets('linux');",
    "const sockets = readdirSync('/proc/self/fd').filter((n) => { try { return readlinkSync('/proc/self/fd/' + n).startsWith('socket:'); } catch { return false; } }).map(Number);",
    "process.send({ closed, sockets }, () => process.disconnect());",
  ].join("\n");
  // fd 4 is a socket the parent hands on, as the shell's Chromium leaves its own open in a spawn.
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"] });
  const report = await new Promise<{ closed: number[]; sockets: number[] }>((resolve, reject) => {
    child.once("message", (m) => resolve(m as { closed: number[]; sockets: number[] }));
    child.once("exit", (code) => reject(new Error(`the child exited ${code} before it answered`)));
  });
  assert.deepEqual(report.closed, [4]);
  assert.deepEqual(report.sockets, [1, 2, 3], "its standard streams and its channel stay");
});
