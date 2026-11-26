import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api } from "../../../lib/api.ts";
import { refreshServerRoomSound, resetServerRoomSoundForTests, serverRoomSound, serverSound } from "./store.ts";

const real = api.getConfig;
const answer = (roomSound: boolean | "fail") => {
  api.getConfig = (async () => {
    if (roomSound === "fail") throw new Error("down");
    return { roomSound };
  }) as unknown as typeof api.getConfig;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  api.getConfig = real;
  resetServerRoomSoundForTests();
});

test("a reconnect reads the server's sound switch again, so a restart with it changed shows without a reload", async () => {
  answer(false);
  await serverRoomSound();
  assert.equal(serverSound(), "off");
  answer(true);
  refreshServerRoomSound();
  await settle();
  assert.equal(serverSound(), "on");
});

test("a failed read after a reconnect keeps the answer the page had", async () => {
  answer(true);
  await serverRoomSound();
  answer("fail");
  refreshServerRoomSound();
  await settle();
  assert.equal(serverSound(), "on");
});

test("nothing is asked before the first answer has been asked for", async () => {
  let asked = 0;
  api.getConfig = (async () => {
    asked += 1;
    return { roomSound: true };
  }) as unknown as typeof api.getConfig;
  refreshServerRoomSound();
  await settle();
  assert.equal(asked, 0);
});
