import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NAME } from "#shared/protocol.ts";
import { ApiError } from "../../../lib/api.ts";
import { OUT_OF_STORAGE, PICK_CAPPED, refusalWords, soundNameOf, stepWords, uploadRefusal } from "./words.ts";

test("a sound's name is its file's, less the extension, with each _ a space", () => {
  assert.equal(soundNameOf("Rain.wav"), "Rain");
  assert.equal(soundNameOf("tavern_night_loop.mp3"), "tavern night loop");
  assert.equal(soundNameOf("archive.tar.gz"), "archive.tar");
  assert.equal(soundNameOf(".mp3"), ".mp3");
  assert.equal(soundNameOf("___.wav"), "Sound");
  assert.equal(soundNameOf("a\u202Eb\u0007c.wav"), "abc");
});

test("a long name stops at MAX_NAME UTF-16 units, never splitting a character", () => {
  const long = soundNameOf(`${"🎵".repeat(60)}.mp3`);
  assert.ok(long.length <= MAX_NAME);
  assert.equal(long, "🎵".repeat(MAX_NAME / 2));
  assert.equal(soundNameOf(`${"x".repeat(200)}.wav`).length, MAX_NAME);
});

test("the steps and the refusals in the design's words", () => {
  assert.equal(stepWords("Rain.wav", { t: "reading" }), "Reading Rain.wav…");
  assert.equal(stepWords("Rain.wav", { t: "converting", percent: 40 }), "Converting Rain.wav… 40%");
  assert.equal(stepWords("Rain.wav", { t: "uploading", percent: 60 }), "Uploading Rain.wav… 60%");
  assert.equal(refusalWords("Rain.ogg", { t: "unreadable" }), "Rain.ogg: this browser can't read it. Try Chrome or Firefox, or make it an MP3 first.");
  assert.equal(refusalWords("Battle.mp3", { t: "tooLong" }), "Battle.mp3: longer than 15 minutes.");
  assert.equal(refusalWords("Thunder.wav", { t: "useTooLong", use: "effect" }), "Thunder.wav: an effect is 30 seconds at most. Add it as background or music.");
  assert.equal(refusalWords("Fanfare.mp3", { t: "useTooShort", use: "music" }), "Fanfare.mp3: music is 30 seconds at least. Add it as an effect.");
  assert.equal(refusalWords("Drip.wav", { t: "useTooShort", use: "loop" }), "Drip.wav: a background sound is 2 seconds at least.");
  assert.equal(refusalWords("Click.wav", { t: "tooShort" }), "Click.wav: shorter than a fifth of a second.");
  assert.equal(refusalWords("Score.flac", { t: "tooBigToRead" }), "Score.flac is too big for this device to read. Add it from a computer.");
  assert.equal(refusalWords("Rain.wav", { t: "outOfMemory" }), "Rain.wav: this device ran out of memory reading it. Add it from a computer.");
  assert.equal(refusalWords("Mix.wav", { t: "channels", channels: 8 }), "Mix.wav has 8 channels. Use a mono or stereo file.");
  assert.equal(refusalWords("Rain.caf", { t: "channelsUnknown" }), "Rain.caf: this app can't tell how many channels it has. Make it an MP3 or WAV first.");
  assert.equal(refusalWords("Big.wav", { t: "fileTooLarge" }), "Big.wav is over 200 MB.");
  assert.equal(refusalWords("Any.wav", { t: "outOfStorage" }), OUT_OF_STORAGE);
  assert.equal(PICK_CAPPED, "Only 20 files at a time: the first 20 are in the queue.");
});

test("the upload's refusals: storage stops the batch, the rest are the image upload's words after the name", () => {
  assert.deepEqual(uploadRefusal(new ApiError(507, "x", "quota_exceeded", null)), { t: "outOfStorage" });
  assert.equal(uploadRefusal(new ApiError(429, "x", "rate_limited", null)).t, "server");
  const busy = uploadRefusal(new ApiError(503, "x", "busy", null));
  assert.deepEqual(busy, { t: "server", text: "The server is busy. Try again in a minute." });
  assert.equal(refusalWords("Rain.wav", busy), "Rain.wav: The server is busy. Try again in a minute.");
});
