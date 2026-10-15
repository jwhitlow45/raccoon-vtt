import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Agent, Dispatcher, MockAgent } from "undici";
import { guardedAgent, guardedLookup, isPublicAddress } from "./egress.ts";
import { AssetError } from "./errors.ts";
import { fetchPublicImage, validateImageUrl } from "./fetchPublic.ts";
import { solid, tempDir } from "./testImages.ts";
import { tempFile } from "./upload.ts";

let dir: string;
let cleanup: () => Promise<void>;
let png: Buffer;
before(async () => {
  ({ dir, cleanup } = await tempDir());
  png = await solid(16, 16).png().toBuffer();
});
after(() => cleanup());

function refusedWith(status: number, code: string) {
  return (err: unknown) => err instanceof AssetError && err.status === status && err.code === code;
}

/** A DNS stand-in, so these tests never touch the network. */
function fakeResolver(table: Record<string, string[]>, seen: string[] = []) {
  return (hostname: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => {
    seen.push(hostname);
    const addresses = table[hostname];
    if (!addresses) return cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    cb(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  };
}

/** Sends img.example to the mock, everything else through the real guarded agent. */
class Router extends Dispatcher {
  mock: MockAgent;
  real: Dispatcher;
  constructor(mock: MockAgent, real: Dispatcher) {
    super();
    this.mock = mock;
    this.real = real;
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const target = String(opts.origin).includes("img.example") || String(opts.origin).includes("serpapi.com") ? this.mock : this.real;
    return target.dispatch(opts, handler);
  }
}

function mockAgent(): MockAgent {
  const mock = new MockAgent();
  mock.disableNetConnect();
  return mock;
}

describe("validateImageUrl", () => {
  test("accepts https on the default port with a DNS name", () => {
    assert.equal(validateImageUrl("https://img.example.com/a.png").hostname, "img.example.com");
    assert.equal(validateImageUrl("https://img.example.com:443/a.png").port, "");
  });

  const refused = [
    "http://img.example.com/a.png",
    "ftp://img.example.com/a.png",
    "https://img.example.com:8443/a.png",
    "https://user:pw@img.example.com/a.png",
    "https://user@img.example.com/a.png",
    "https://127.0.0.1/a.png",
    "https://10.0.0.1/a.png",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a.png",
    "https://[::ffff:127.0.0.1]/a.png",
    "https://2130706433/a.png",
    "https://0x7f.1/a.png",
    "https://localhost/a.png",
    "https://postgres/a.png",
    "https://img.example.com./a.png",
    "not a url",
    `https://img.example.com/${"a".repeat(2100)}`,
  ];
  for (const url of refused) {
    test(`refuses ${url.slice(0, 60)}`, () => {
      assert.throws(() => validateImageUrl(url), refusedWith(400, "bad_url"));
    });
  }

  test("a pinned host refuses every other host", () => {
    assert.equal(validateImageUrl("https://serpapi.com/x.jpg", "serpapi.com").hostname, "serpapi.com");
    assert.throws(() => validateImageUrl("https://www.serpapi.com/x.jpg", "serpapi.com"), refusedWith(400, "bad_url"));
    assert.throws(() => validateImageUrl("https://serpapi.com.evil.example/x.jpg", "serpapi.com"));
  });
});

describe("the development DNS guard", () => {
  test("only global unicast addresses are public", () => {
    for (const ip of ["8.8.8.8", "93.184.215.14", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) assert.ok(isPublicAddress(ip), ip);
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.17.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "garbage",
    ]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  test("a host is refused when any of its addresses is private", async () => {
    const lookup = guardedLookup(fakeResolver({ "mixed.example": ["93.184.215.14", "10.0.0.7"] }));
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("mixed.example", {}, (e) => resolve(e)),
    );
    assert.equal(err?.code, "EBLOCKED");
  });

  test("a public host resolves in both lookup shapes", async () => {
    const lookup = guardedLookup(fakeResolver({ "ok.example": ["93.184.215.14"] }));
    const single = await new Promise<unknown[]>((resolve) => lookup("ok.example", {}, (...args) => resolve(args)));
    assert.deepEqual(single, [null, "93.184.215.14", 4]);
    const all = await new Promise<unknown[]>((resolve) => lookup("ok.example", { all: true }, (...args) => resolve(args)));
    assert.deepEqual(all, [null, [{ address: "93.184.215.14", family: 4 }]]);
  });

  test("a real fetch through the guarded agent never connects to a private address", async () => {
    const seen: string[] = [];
    const agent = guardedAgent(fakeResolver({ "intranet.example": ["192.168.1.10"] }, seen));
    await assert.rejects(
      fetchPublicImage("https://intranet.example/a.png", { dispatcher: agent, path: tempFile(dir, "fetch") }),
      refusedWith(422, "fetch_failed"),
    );
    assert.deepEqual(seen, ["intranet.example"]);
    await agent.close();
  });
});

describe("fetchPublicImage", () => {
  test("downloads an image with identity encoding and hashes it", async () => {
    const mock = mockAgent();
    mock
      .get("https://img.example")
      .intercept({ path: "/goblin.png", headers: { "accept-encoding": "identity" } })
      .reply(200, png, { headers: { "content-length": String(png.length), "content-type": "image/png" } });
    const path = tempFile(dir, "fetch");
    const got = await fetchPublicImage("https://img.example/goblin.png", { dispatcher: mock, path });
    assert.equal(got.size, png.length);
    assert.deepEqual(got.sha256, createHash("sha256").update(png).digest());
    assert.deepEqual(await readFile(path), png);
    assert.equal(got.finalUrl.href, "https://img.example/goblin.png");
  });

  test("follows up to 3 redirects, checking each hop", async () => {
    const mock = mockAgent();
    const pool = mock.get("https://img.example");
    pool.intercept({ path: "/1" }).reply(302, "", { headers: { location: "/2" } });
    pool.intercept({ path: "/2" }).reply(301, "", { headers: { location: "https://img.example/3" } });
    pool.intercept({ path: "/3" }).reply(307, "", { headers: { location: "/final.png" } });
    pool.intercept({ path: "/final.png" }).reply(200, png);
    const got = await fetchPublicImage("https://img.example/1", { dispatcher: mock, path: tempFile(dir, "fetch") });
    assert.equal(got.finalUrl.pathname, "/final.png");
  });

  test("a fourth redirect is refused", async () => {
    const mock = mockAgent();
    const pool = mock.get("https://img.example");
    for (let i = 1; i <= 4; i++) pool.intercept({ path: `/${i}` }).reply(302, "", { headers: { location: `/${i + 1}` } });
    pool.intercept({ path: "/5" }).reply(200, png);
    await assert.rejects(
      fetchPublicImage("https://img.example/1", { dispatcher: mock, path: tempFile(dir, "fetch") }),
      refusedWith(422, "fetch_failed"),
    );
  });

  test("a redirect to an IP literal is refused without connecting", async () => {
    const mock = mockAgent();
    mock.get("https://img.example").intercept({ path: "/a" }).reply(302, "", { headers: { location: "https://169.254.169.254/" } });
    await assert.rejects(
      fetchPublicImage("https://img.example/a", { dispatcher: mock, path: tempFile(dir, "fetch") }),
      refusedWith(422, "fetch_failed"),
    );
  });

  test("a redirect to a host that resolves privately is refused by the DNS guard", async () => {
    const mock = mockAgent();
    mock.get("https://img.example").intercept({ path: "/a" }).reply(302, "", { headers: { location: "https://router.example/admin" } });
    const seen: string[] = [];
    const real = guardedAgent(fakeResolver({ "router.example": ["192.168.0.1"] }, seen));
    await assert.rejects(
      fetchPublicImage("https://img.example/a", { dispatcher: new Router(mock, real), path: tempFile(dir, "fetch") }),
      refusedWith(422, "fetch_failed"),
    );
    assert.deepEqual(seen, ["router.example"]);
    await real.close();
  });

  test("a redirect to plain http or another port is refused", async () => {
    for (const location of ["http://img.example/a.png", "https://img.example:8443/a.png"]) {
      const mock = mockAgent();
      mock.get("https://img.example").intercept({ path: "/a" }).reply(302, "", { headers: { location } });
      await assert.rejects(
        fetchPublicImage("https://img.example/a", { dispatcher: mock, path: tempFile(dir, "fetch") }),
        refusedWith(422, "fetch_failed"),
      );
    }
  });

  test("a pinned host refuses a redirect elsewhere", async () => {
    const mock = mockAgent();
    mock.get("https://serpapi.com").intercept({ path: "/t.jpg" }).reply(302, "", { headers: { location: "https://img.example/x.png" } });
    await assert.rejects(
      fetchPublicImage("https://serpapi.com/t.jpg", { dispatcher: mock, path: tempFile(dir, "fetch"), allowedHost: "serpapi.com" }),
      refusedWith(422, "fetch_failed"),
    );
  });

  test("an oversized Content-Length is refused before the body is read", async () => {
    const mock = mockAgent();
    mock
      .get("https://img.example")
      .intercept({ path: "/big.png" })
      .reply(200, png, { headers: { "content-length": String(11 * 1024 * 1024) } });
    await assert.rejects(
      fetchPublicImage("https://img.example/big.png", { dispatcher: mock, path: tempFile(dir, "fetch") }),
      refusedWith(413, "too_large"),
    );
  });

  test("a body without Content-Length is cut off once it passes the cap", async () => {
    const mock = mockAgent();
    const body = Buffer.concat([png, Buffer.alloc(4096)]);
    mock.get("https://img.example").intercept({ path: "/stream.png" }).reply(200, body);
    await assert.rejects(
      fetchPublicImage("https://img.example/stream.png", { dispatcher: mock, path: tempFile(dir, "fetch"), maxBytes: 1024 }),
      refusedWith(413, "too_large"),
    );
  });

  test("bytes that are not an allowed image are refused, whatever the Content-Type says", async () => {
    const mock = mockAgent();
    const pool = mock.get("https://img.example");
    pool.intercept({ path: "/page.png" }).reply(200, "<!doctype html><script>alert(1)</script>", { headers: { "content-type": "image/png" } });
    pool.intercept({ path: "/x.svg" }).reply(200, '<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { "content-type": "image/svg+xml" } });
    for (const p of ["/page.png", "/x.svg"]) {
      await assert.rejects(
        fetchPublicImage(`https://img.example${p}`, { dispatcher: mock, path: tempFile(dir, "fetch") }),
        refusedWith(415, "unsupported_type"),
      );
    }
  });

  test("errors, compressed bodies and timeouts all read as fetch_failed", async () => {
    const mock = mockAgent();
    const pool = mock.get("https://img.example");
    pool.intercept({ path: "/404" }).reply(404, "nope");
    pool.intercept({ path: "/gz" }).reply(200, png, { headers: { "content-encoding": "gzip" } });
    pool.intercept({ path: "/slow" }).reply(200, png).delay(500);
    for (const p of ["/404", "/gz"]) {
      await assert.rejects(
        fetchPublicImage(`https://img.example${p}`, { dispatcher: mock, path: tempFile(dir, "fetch") }),
        refusedWith(422, "fetch_failed"),
      );
    }
    await assert.rejects(
      fetchPublicImage("https://img.example/slow", { dispatcher: mock, path: tempFile(dir, "fetch"), timeoutMs: 100 }),
      refusedWith(422, "fetch_failed"),
    );
  });
});

/**
 * The mock agent hands over a body that ends on its own, so it cannot show
 * what a real socket does when a refused answer's body is destroyed unread.
 * Here a local server answers every refused case over real TCP: the agent's
 * connector sends each "https" request there in plain HTTP, so the hosts
 * still pass the URL checks.
 */
describe("fetchPublicImage over a real connection", () => {
  let server: Server;
  let agent: Agent;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/moved") return void res.writeHead(302, { location: "/missing" }).end("moved");
      if (req.url === "/gz") return void res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" }).end("not really gzip");
      if (req.url === "/huge") return void res.writeHead(200, { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) }).end();
      res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><p>Not found</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    agent = new Agent({
      connect: (_opts, callback) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => callback(null, socket));
        socket.once("error", (err) => callback(err, null));
      },
    });
  });
  after(async () => {
    await agent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a 404, a redirect to one, a compressed body and an oversized one are refused without crashing the process (LP5-OPS-1)", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      for (const [path, check] of [
        ["/missing", refusedWith(422, "fetch_failed")],
        ["/moved", refusedWith(422, "fetch_failed")],
        ["/gz", refusedWith(422, "fetch_failed")],
        ["/huge", refusedWith(413, "too_large")],
      ] as const) {
        await assert.rejects(fetchPublicImage(`https://img.example.com${path}`, { dispatcher: agent, path: tempFile(dir, "fetch") }), check);
      }
      // The abort error of a destroyed body arrives a tick or more later.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(uncaught, []);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
