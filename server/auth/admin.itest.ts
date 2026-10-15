import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verify } from "@node-rs/argon2";
import type { RoomState } from "#shared/model.ts";
import { readPlayerFragment } from "#shared/playerLink.ts";
import { startTestApp, TEST_DATABASE_URL, type TestApp } from "./testing.ts";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function admin(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["scripts/admin.ts", ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_DATABASE_URL, PUBLIC_ORIGIN: "https://vtt.example.com" },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}

describe("scripts/admin.ts", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test("create-room prints a working password, player link and DM link, without touching the limits", async () => {
    const out = await admin("create-room", "Admin Room", "DM");
    assert.equal(out.code, 0, out.stderr);
    const id = /Room (\w{4}-\w{4})/.exec(out.stdout)?.[1] ?? "";
    const password = /Player password: (\S+)/.exec(out.stdout)?.[1] ?? "";
    const playerLink = /Player link: (\S+)/.exec(out.stdout)?.[1] ?? "";
    const link = /DM link: (\S+)/.exec(out.stdout)?.[1] ?? "";
    const roomId = id.replace("-", "");
    t.track(roomId);
    assert.match(password, /^[0-9a-z]{5}-[0-9a-z]{5}-[0-9a-z]{5}$/);
    assert.equal(playerLink, `https://vtt.example.com/r/${id}#pw=${password}`);
    assert.ok(link.startsWith(`https://vtt.example.com/r/${id}#dm=`), link);

    // The link's own password joins, read the way the browser reads it.
    const fromLink = readPlayerFragment(new URL(playerLink).hash)?.password ?? "";
    assert.equal(fromLink, password);
    await t.client().join(roomId, "Linked", fromLink);

    const { rows } = await t.pool.query<{ created_ip: string | null }>("select created_ip from rooms where id = $1", [roomId]);
    assert.equal(rows[0]?.created_ip, null);

    const player = t.client();
    await player.join(roomId, "P", password);
    const dm = t.client();
    const key = link.split("#dm=")[1] ?? "";
    assert.equal((await dm.post(`/api/rooms/${roomId}/dm`, { key, name: "DM" })).statusCode, 200);
    // The room's DM can show the same player link later (design 10.2).
    const shown = await dm.get(`/api/rooms/${roomId}/player-link`);
    assert.equal(shown.json<{ playerLink: string }>().playerLink, playerLink.slice("https://vtt.example.com".length));
    const snap = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    assert.equal(snap.rows[0]?.state.meta.name, "Admin Room");
  });

  test("pin and unpin", async () => {
    const { roomId } = await t.client().createRoom("Pinnable");
    assert.equal((await admin("pin", roomId)).code, 0);
    const pinned = await t.pool.query<{ pinned: boolean }>("select pinned from rooms where id = $1", [roomId]);
    assert.equal(pinned.rows[0]?.pinned, true);
    assert.equal((await admin("unpin", `${roomId.slice(0, 4)}-${roomId.slice(4)}`)).code, 0);
    const unpinned = await t.pool.query<{ pinned: boolean }>("select pinned from rooms where id = $1", [roomId]);
    assert.equal(unpinned.rows[0]?.pinned, false);
    assert.equal((await admin("pin", "ZZZZZZZZ")).code, 2);
    assert.equal((await admin("pin", "nonsense")).code, 2);
  });

  test("dm-link replaces the key and signs out every DM device", async () => {
    const owner = t.client();
    const { roomId, dmKey } = await owner.createRoom("Recover me");
    const out = await admin("dm-link", roomId);
    assert.equal(out.code, 0, out.stderr);
    const key = /#dm=(\S+)/.exec(out.stdout)?.[1] ?? "";
    assert.notEqual(key, dmKey);
    assert.equal((await owner.me(roomId)).status, 403);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    assert.ok(Object.values(rows[0]?.state.members ?? {}).every((m) => m.kind === "player"));
    assert.equal((await t.client().post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Old" })).statusCode, 403);
    assert.equal((await owner.post(`/api/rooms/${roomId}/dm`, { key, name: "Recovered" })).statusCode, 200);
    assert.equal((await admin("dm-link", "ZZZZZZZZ")).code, 2);
  });

  test("list-rooms shows each room with its size", async () => {
    const { roomId } = await t.client().createRoom("Listed room");
    const out = await admin("list-rooms");
    assert.equal(out.code, 0, out.stderr);
    const line = out.stdout.split("\n").find((l) => l.startsWith(`${roomId.slice(0, 4)}-${roomId.slice(4)}`));
    assert.ok(line, out.stdout);
    assert.match(line, /\d+(\.\d)? KiB {2}Listed room$/);
  });

  test("list-rooms prints a hostile room name escaped, never raw", async () => {
    const { roomId } = await t.client().createRoom("Plain for now");
    await t.pool.query("update rooms set name = $2 where id = $1", [roomId, "\u001b]0;pwned\u0007\u001b[2JEvil\u009b31m\u202Eman"]);
    const out = await admin("list-rooms");
    assert.equal(out.code, 0, out.stderr);
    const line = out.stdout.split("\n").find((l) => l.startsWith(`${roomId.slice(0, 4)}-${roomId.slice(4)}`));
    assert.ok(line, out.stdout);
    assert.ok(line.endsWith("\\u{1b}]0;pwned\\u{7}\\u{1b}[2JEvil\\u{9b}31m\\u{202e}man"), line);
    assert.doesNotMatch(out.stdout, /[\u001b\u0007\u009b\u202e]/);
  });

  test("create-room and import refuse names the site would refuse", async () => {
    const out = await admin("create-room", "Thursday\u2028Group", "DM");
    assert.equal(out.code, 2);
    assert.match(out.stderr, /control or text direction/);
    const dm = await admin("create-room", "Room", "\u001b[2JDM");
    assert.equal(dm.code, 2);
    const imp = await admin("import", "/nonexistent.zip", "DM\u202E");
    assert.equal(imp.code, 2);
    assert.match(imp.stderr, /control or text direction/);
  });

  test("hash-password refuses short, common and mismatched passwords, and prints a line .env takes as it is", async () => {
    const hash = async (input: string) => {
      const child = execFile(process.execPath, ["scripts/admin.ts", "hash-password"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } });
      child.stdin?.end(input);
      return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += String(d)));
        child.stderr?.on("data", (d) => (stderr += String(d)));
        child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
      });
    };
    const short = await hash("fifteen-chars-x\n");
    assert.equal(short.code, 2);
    assert.match(short.stderr, /16 or more characters/);
    const common = await hash("films+pic+galeries\n");
    assert.equal(common.code, 2);
    assert.match(common.stderr, /common passwords/);
    const differ = await hash("a-perfectly-long-password\na-perfectly-long-passw0rd\n");
    assert.equal(differ.code, 2);
    assert.match(differ.stderr, /differ/);
    assert.doesNotMatch(differ.stdout, /ADMIN_PASSWORD_HASH/);

    const typed = await hash("a-perfectly-long-password\na-perfectly-long-password\n");
    assert.equal(typed.code, 0, typed.stderr);
    const line = /^ADMIN_PASSWORD_HASH='(\$argon2id\$[^']+)'$/m.exec(typed.stdout);
    assert.ok(line, typed.stdout);
    assert.equal(await verify(line[1]!, "a-perfectly-long-password"), true);
    assert.doesNotMatch(typed.stdout, /a-perfectly-long-password/, "the typed password is never printed");

    const made = await hash("\n");
    assert.equal(made.code, 0, made.stderr);
    const password = /Your admin password is: (\S+)/.exec(made.stdout)?.[1] ?? "";
    assert.ok(password.length >= 16, made.stdout);
    const madeLine = /^ADMIN_PASSWORD_HASH='([^']+)'$/m.exec(made.stdout);
    assert.equal(await verify(madeLine![1]!, password), true);
  });

  test("unknown commands print usage", async () => {
    const out = await admin("frobnicate");
    assert.equal(out.code, 2);
    assert.match(out.stderr, /Usage/);
  });
});
