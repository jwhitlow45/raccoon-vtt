import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { playerLink, readPlayerFragment } from "./playerLink.ts";

describe("player link", () => {
  test("is the room path with the password in the fragment", () => {
    assert.equal(playerLink("K7QH2MXA", "owlbear-druid-wand"), "/r/K7QH-2MXA#pw=owlbear-druid-wand");
    assert.equal(playerLink("K7QH-2MXA", "owlbear-druid-wand"), "/r/K7QH-2MXA#pw=owlbear-druid-wand");
  });

  test("escapes what would break the fragment or get dropped by a chat app", () => {
    assert.equal(playerLink("K7QH2MXA", "a b&c#d=e+f%g"), "/r/K7QH-2MXA#pw=a%20b%26c%23d%3De%2Bf%25g");
    assert.equal(playerLink("K7QH2MXA", "secret.!)"), "/r/K7QH-2MXA#pw=secret%2E%21%29");
    assert.match(playerLink("K7QH2MXA", "it's (a) ~*star*~"), /^\/r\/K7QH-2MXA#pw=[A-Za-z0-9%_-]+$/);
  });

  test("every password survives the round trip", () => {
    for (const password of [
      "owlbear-druid-wand",
      "abcde-fghij-klmno",
      "a b&c#d=e+f%g",
      "secret.!)",
      "it's (a) ~*star*~",
      "pw=inside&dm=nope",
      "Grüße, café ünïcödé",
      "dragon 🐉 hoard",
      "%41 is not A",
    ]) {
      const link = playerLink("K7QH2MXA", password);
      const hash = link.slice(link.indexOf("#"));
      assert.deepEqual(readPlayerFragment(hash), { password, hash: "" }, password);
    }
  });
});

describe("reading the fragment", () => {
  test("no pw= means no player link", () => {
    assert.equal(readPlayerFragment(""), null);
    assert.equal(readPlayerFragment("#"), null);
    assert.equal(readPlayerFragment("#section"), null);
    assert.equal(readPlayerFragment("#dm=q5pYb8lJcN0p6tDq3kXz9wR1sV2uF4hG7jK8mN0pQ2s"), null);
    assert.equal(readPlayerFragment("#pwd=x"), null);
  });

  test("takes every pw= out and keeps the rest", () => {
    assert.deepEqual(readPlayerFragment("#pw=one&x=1&pw=two"), { password: "one", hash: "#x=1" });
    assert.deepEqual(readPlayerFragment("#x=1&pw=one"), { password: "one", hash: "#x=1" });
    assert.deepEqual(readPlayerFragment("pw=one&"), { password: "one", hash: "" });
  });

  test("an empty or broken password is found but has no value", () => {
    assert.deepEqual(readPlayerFragment("#pw="), { password: null, hash: "" });
    assert.deepEqual(readPlayerFragment("#pw=owlbear%2"), { password: null, hash: "" });
    assert.deepEqual(readPlayerFragment("#pw=%E0%A4%A"), { password: null, hash: "" });
  });

  test("a raw plus stays a plus, since the link never writes one for a space", () => {
    assert.deepEqual(readPlayerFragment("#pw=a+b"), { password: "a+b", hash: "" });
  });
});
