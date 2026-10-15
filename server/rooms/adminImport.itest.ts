import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ProjectedState } from "#shared/project.ts";
import { solid } from "../assets/testImages.ts";
import { startEngine, TEST_DATABASE_URL, type Engine } from "./testing.ts";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The admin `import` command (design 16.4): the same pipeline as the site, for files too big for the upload limit. */
describe("scripts/admin.ts import", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("restores an export from a file on the volume and prints the new room's secrets", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Archived");
    const map = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=map`, undefined, { "content-type": "image/png" }, await solid(200, 100).png().toBuffer());
    assert.equal(map.statusCode, 200, map.body);
    const s = await t.connect(roomId, dm);
    const sceneId = ((await s.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    await s.apply({ t: "scene.setMap", sceneId, map: { assetId: map.json<{ id: string }>().id, widthPx: 1, heightPx: 1, cellPx: 25, originPx: { x: 0, y: 0 } } });
    await s.apply({ t: "log.chat", text: "kept" });
    s.close();
    const exported = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(exported.statusCode, 200);
    const path = join(t.assetDir, "archived.zip");
    await writeFile(path, exported.rawPayload);
    // An upload the running server has in flight, which the CLI must leave alone.
    const inFlight = join(t.assetDir, "tmp", "intake-in-flight");
    await writeFile(inFlight, "partial upload");

    const out = await run(process.execPath, ["scripts/admin.ts", "import", path, "Restorer"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_DATABASE_URL, ASSET_DIR: t.assetDir, PUBLIC_ORIGIN: "https://vtt.example.com" },
    });
    assert.equal(await readFile(inFlight, "utf8"), "partial upload", "the server's temporary files are untouched");
    assert.deepEqual(
      (await readdir(join(t.assetDir, "tmp"))).filter((name) => name.startsWith("cli-")),
      [],
      "the CLI removes its own folder",
    );
    const id = /Imported room (\w{4}-\w{4})/.exec(out.stdout)?.[1] ?? "";
    const password = /Player password: (\S+)/.exec(out.stdout)?.[1] ?? "";
    const link = /DM link: (\S+)/.exec(out.stdout)?.[1] ?? "";
    const newId = id.replace("-", "");
    t.track(newId);
    assert.match(password, /^[0-9a-z]{5}-[0-9a-z]{5}-[0-9a-z]{5}$/);
    assert.ok(link.startsWith(`https://vtt.example.com/r/${id}#dm=`), link);
    assert.match(out.stdout, new RegExp(`^Player link: https://vtt\\.example\\.com/r/${id}#pw=${password}$`, "m"));

    const restorer = t.client();
    await restorer.claimDm(newId, link.split("#dm=")[1] ?? "", "Restorer");
    const socket = await t.connect(newId, restorer);
    const state = (await socket.snapshot("r")).state as ProjectedState;
    const scene = Object.values(state.scenes)[0]!;
    assert.equal(scene.map?.widthPx, 200);
    assert.equal(state.log.some((e) => e.text === "kept"), true);
    const player = t.client();
    await player.join(newId, "Pip", password);
    socket.close();
    const bad = (await run(process.execPath, ["scripts/admin.ts", "import", join(t.assetDir, "missing.zip")], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_DATABASE_URL, ASSET_DIR: t.assetDir },
    }).catch((err: unknown) => err)) as { code?: number; stderr?: string };
    assert.equal(bad.code, 2);
    assert.match(bad.stderr ?? "", /bad_zip/);
  });
});
