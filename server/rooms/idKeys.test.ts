import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { sealedId, sealedTime } from "#shared/ids.ts";
import { RoomIdKeys } from "./idKeys.ts";

const secret = createHash("sha256").update("a test secret").digest();

test("a member's key and the room's server key are HMACs of the ids root, as written", () => {
  const root = createHmac("sha256", secret).update("raccoon ids root v1").digest();
  const member = createHmac("sha256", root).update(Buffer.concat([Buffer.from("member"), Buffer.of(0), Buffer.from("room-1"), Buffer.of(0), Buffer.from("m-1")])).digest();
  const server = createHmac("sha256", root).update(Buffer.concat([Buffer.from("server"), Buffer.of(0), Buffer.from("room-1")])).digest();
  const keys = new RoomIdKeys(secret, "room-1");
  assert.equal(keys.member("m-1").text, member.toString("base64url"));
  assert.equal(keys.server.text, server.toString("base64url"));
});

test("each member of each room has a key of their own, and the server another", () => {
  const a = new RoomIdKeys(secret, "room-1");
  const b = new RoomIdKeys(secret, "room-2");
  const texts = [a.member("m-1"), a.member("m-2"), a.member("server"), a.server, b.member("m-1"), b.server, new RoomIdKeys(Buffer.alloc(32, 7), "room-1").member("m-1")].map((k) => k.text);
  assert.equal(new Set(texts).size, texts.length);
  assert.equal(a.member("m-1"), a.member("m-1"), "derived once");
  assert.equal(new RoomIdKeys(secret, "room-1").member("m-1").text, a.member("m-1").text, "and the same after a restart");
});

test("an id sealed under a member's key reads under that key alone", () => {
  const keys = new RoomIdKeys(secret, "room-1");
  const id = sealedId(keys.member("m-1").key, 1_700_000_000_000);
  assert.equal(sealedTime(keys.member("m-1").key, id), 1_700_000_000_000);
  keys.forget("m-1");
  assert.equal(sealedTime(keys.member("m-1").key, id), 1_700_000_000_000, "derived again the same");
});
