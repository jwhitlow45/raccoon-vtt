import assert from "node:assert/strict";
import { test } from "node:test";
import { ipKey } from "./ipKey.ts";

test("IPv4 is counted per address", () => {
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("::ffff:203.0.113.9"), "203.0.113.9");
});

test("IPv6 is counted per /64, however it is written", () => {
  assert.equal(ipKey("2001:db8:abcd:12::1"), "2001:db8:abcd:12::/64");
  assert.equal(ipKey("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"), "2001:db8:abcd:12::/64");
  assert.equal(ipKey("2001:DB8:ABCD:12::99"), "2001:db8:abcd:12::/64");
  assert.notEqual(ipKey("2001:db8:abcd:13::1"), ipKey("2001:db8:abcd:12::1"));
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
});

test("anything else passes through", () => {
  assert.equal(ipKey("unknown"), "unknown");
  assert.equal(ipKey(""), "");
});
