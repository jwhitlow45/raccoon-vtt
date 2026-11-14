import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpError } from "../auth/http.ts";
import { dropForeignPeer, isHostComputer, originPolicy, privatePeer, requireHostComputer, thisComputer, type PolicyConfig } from "./guard.ts";

const P = 3170;
const local = (host: "127.0.0.1" | "0.0.0.0", port = P): PolicyConfig => ({ local: true, publicOrigin: `http://localhost:${port}`, PORT: port, HOST: host });
const addresses = (list: string[]) => ({ localAddresses: () => list });
const peer = (remoteAddress: string | undefined) => ({ socket: { remoteAddress } }) as Parameters<typeof isHostComputer>[0];

describe("originPolicy, hosted", () => {
  const hosted = originPolicy({ local: false, publicOrigin: "https://vtt.example.com", PORT: 3000, HOST: "0.0.0.0" }, addresses(["10.0.0.5"]));

  test("the one public origin, exactly, as before", () => {
    assert.equal(hosted.originAllowed("https://vtt.example.com"), true);
    for (const o of ["https://vtt.example.com/", "http://vtt.example.com", "http://localhost:3000", "http://10.0.0.5:3000", "null", undefined]) assert.equal(hosted.originAllowed(o), false, String(o));
  });

  test("no Host check", () => {
    assert.equal(hosted.hostAllowed("evil.example"), true);
    assert.equal(hosted.hostAllowed(undefined), true);
  });
});

describe("originPolicy, local (design 6.2)", () => {
  test("only this computer: localhost and 127.0.0.1 on the port, and never its network address", () => {
    const policy = originPolicy(local("127.0.0.1"), addresses(["10.0.0.5", "172.16.0.2"]));
    assert.equal(policy.originAllowed(`http://localhost:${P}`), true);
    assert.equal(policy.originAllowed(`http://127.0.0.1:${P}`), true);
    assert.equal(policy.originAllowed(`http://10.0.0.5:${P}`), false);
    assert.equal(policy.hostAllowed(`localhost:${P}`), true);
    assert.equal(policy.hostAllowed(`127.0.0.1:${P}`), true);
    assert.equal(policy.hostAllowed(`10.0.0.5:${P}`), false);
  });

  test("players on the network: every private address of this computer too", () => {
    const policy = originPolicy(local("0.0.0.0"), addresses(["10.0.0.5", "172.16.0.2"]));
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.0.2"]) {
      assert.equal(policy.originAllowed(`http://${h}:${P}`), true, h);
      assert.equal(policy.hostAllowed(`${h}:${P}`), true, h);
    }
  });

  test("`Origin: null`, another scheme, port, path or host are refused, and so is none", () => {
    const policy = originPolicy(local("0.0.0.0"), addresses(["10.0.0.5"]));
    const refused = [
      "null",
      undefined,
      "",
      `https://localhost:${P}`,
      `http://localhost:${P + 1}`,
      "http://localhost",
      `http://localhost:${P}/`,
      `http://localhost:${P}@evil.example`,
      `http://evil.example:${P}`,
      `http://10.0.0.6:${P}`,
      `http://localhost.:${P}`,
      `http://[::1]:${P}`,
      `ws://localhost:${P}`,
    ];
    for (const o of refused) assert.equal(policy.originAllowed(o), false, String(o));
  });

  test("a Host a rebound domain sends, or none, is refused, while case is not a difference", () => {
    const policy = originPolicy(local("0.0.0.0"), addresses(["10.0.0.5"]));
    for (const h of [`evil.example:${P}`, "evil.example", `localhost:${P + 1}`, "localhost", `localhost.:${P}`, `[::1]:${P}`, "", undefined]) assert.equal(policy.hostAllowed(h), false, String(h));
    assert.equal(policy.hostAllowed(`LOCALHOST:${P}`), true);
  });

  test("a new address joins at once, and a gone one leaves", () => {
    let list = ["10.0.0.5"];
    const policy = originPolicy(local("0.0.0.0"), { localAddresses: () => list });
    assert.equal(policy.originAllowed(`http://172.16.0.9:${P}`), false);
    list = ["172.16.0.9"];
    assert.equal(policy.originAllowed(`http://172.16.0.9:${P}`), true);
    assert.equal(policy.hostAllowed(`10.0.0.5:${P}`), false);
  });

  test("on port 80 a browser leaves the port out", () => {
    const policy = originPolicy(local("127.0.0.1", 80), addresses([]));
    assert.equal(policy.originAllowed("http://localhost"), true);
    assert.equal(policy.hostAllowed("127.0.0.1"), true);
    assert.equal(policy.originAllowed("http://localhost:80"), false);
  });
});

describe("peers", () => {
  test("only loopback and private IPv4 addresses may connect", () => {
    for (const a of ["127.0.0.1", "10.0.0.5", "172.16.0.2", "172.31.1.1", "::ffff:10.0.0.5", "::ffff:127.0.0.1"]) assert.equal(privatePeer(a), true, a);
    // A forwarded port, a public address, CGNAT and Tailscale, link-local, and anything IPv6.
    for (const a of ["203.0.113.9", "8.8.8.8", "100.64.0.1", "100.100.100.100", "169.254.10.10", "172.32.0.1", "::1", "fe80::1", "2001:db8::1", "", undefined]) {
      assert.equal(privatePeer(a), false, String(a));
    }
  });

  test("a connection from outside is destroyed before HTTP reads it, and one from inside is left alone", () => {
    const destroyed: string[] = [];
    const socket = (remoteAddress: string | undefined) => ({ remoteAddress, destroy: () => destroyed.push(String(remoteAddress)) });
    for (const a of ["203.0.113.9", "100.64.0.1", "169.254.1.1", undefined]) dropForeignPeer(socket(a));
    for (const a of ["127.0.0.1", "10.0.0.5", "::ffff:172.16.0.2"]) dropForeignPeer(socket(a));
    assert.deepEqual(destroyed, ["203.0.113.9", "100.64.0.1", "169.254.1.1", "undefined"]);
  });

  test("the host computer is a loopback socket, never this computer's network address", () => {
    for (const a of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) assert.equal(isHostComputer(peer(a)), true, a);
    for (const a of ["10.0.0.5", "172.16.0.2", undefined]) assert.equal(isHostComputer(peer(a)), false, String(a));
  });

  test("this computer is loopback or one of its own addresses (D-261113-095)", () => {
    const net = addresses(["10.0.0.5"]);
    for (const a of ["127.0.0.1", "::1", "10.0.0.5", "::ffff:10.0.0.5"]) assert.equal(thisComputer(a, net), true, a);
    for (const a of ["10.0.0.6", "172.16.0.2", "unknown", "2001:db8::/64"]) assert.equal(thisComputer(a, net), false, a);
  });
});

describe("requireHostComputer (D-261113-081)", () => {
  test("local mode refuses every other device with host_only", () => {
    assert.doesNotThrow(() => requireHostComputer({ local: true }, peer("127.0.0.1")));
    for (const a of ["10.0.0.5", "172.16.0.2", undefined]) {
      assert.throws(
        () => requireHostComputer({ local: true }, peer(a)),
        (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === "host_only",
        String(a),
      );
    }
  });

  test("a hosted server lets any address through", () => {
    for (const a of ["127.0.0.1", "10.0.0.5", "203.0.113.9", undefined]) assert.doesNotThrow(() => requireHostComputer({ local: false }, peer(a)));
  });
});
