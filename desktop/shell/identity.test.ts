import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_NAME } from "../contract.ts";
import { APP_ID } from "./identity.ts";

const builder = readFileSync(new URL("../build/electron-builder.yml", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("the shell and the installers name the app the same way", () => {
  assert.equal(/^appId: (\S+)$/m.exec(builder)?.[1], APP_ID, "the AppUserModelID notifications use must be the shortcut's");
  assert.equal(/^productName: (\S+)$/m.exec(builder)?.[1], APP_NAME);
  // Electron names its profile folder and app.name from package.json, not from electron-builder.yml.
  assert.equal(pkg.productName, APP_NAME);
  assert.equal(pkg.main, "out/main/main.cjs");
});

test("every release asset is named as design 11.5 lists them", () => {
  assert.match(builder, /^  artifactName: raccoon-vtt-\$\{version\}-windows-\$\{arch\}-setup\.\$\{ext\}$/m);
  assert.match(builder, /^  artifactName: raccoon-vtt-\$\{version\}-macos-\$\{arch\}\.\$\{ext\}$/m);
  assert.match(builder, /^  artifactName: raccoon-vtt-\$\{version\}-linux-\$\{arch\}\.\$\{ext\}$/m);
  assert.match(builder, /^  artifactName: raccoon-vtt_\$\{version\}_\$\{arch\}\.\$\{ext\}$/m);
  assert.match(builder, /^  minimumSystemVersion: "15\.0"$/m);
  assert.match(builder, /^    - libc6 \(>= 2\.36\)$/m);
});
