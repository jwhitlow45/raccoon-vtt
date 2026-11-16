import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { TEST_PORTS } from "./testPorts.ts";

/** Where Linux's ephemeral range starts by default, so a port picked on a Mac still fails here before a Linux runner. */
const LINUX_EPHEMERAL_FLOOR = 32768;
const ports = Object.entries(TEST_PORTS);

test("every fixed test port is its own and below Linux's default ephemeral range", () => {
  assert.equal(new Set(ports.map(([, port]) => port)).size, ports.length, "no two tests share a port");
  for (const [name, port] of ports) assert.ok(port >= 1024 && port < LINUX_EPHEMERAL_FLOOR, `${name} is ${port}`);
});

test("on Linux, no fixed test port is in this machine's ephemeral range", { skip: process.platform !== "linux" && "the range is read from /proc" }, async () => {
  const [low, high] = (await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8")).trim().split(/\s+/).map(Number);
  assert.ok(Number.isInteger(low) && Number.isInteger(high), "the range reads as two ports");
  for (const [name, port] of ports) assert.ok(port < low! || port > high!, `${name} is ${port}, inside ${low} to ${high}`);
});
