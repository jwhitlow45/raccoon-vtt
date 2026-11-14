import { test } from "node:test";
import assert from "node:assert/strict";
import type { UpdateState } from "../contract.ts";
import { Installer, type InstallSteps } from "./install.ts";
import {
  clockOffsetMinutes,
  compareVersions,
  releaseAssetName,
  releaseOffer,
  sourcePage,
  tagVersion,
  updateSource,
  updaterErrorLevel,
  userAgent,
} from "./updates.ts";

// ---------------------------------------------------------------------------
// Where updates come from

test("Windows and the AppImage update themselves, macOS and the deb link the release page", () => {
  assert.equal(updateSource("win32", {}), "updater");
  assert.equal(updateSource("linux", { APPIMAGE: "/home/dm/raccoon-vtt-0.5.0-linux-x86_64.AppImage" }), "updater");
  assert.equal(updateSource("linux", {}), "release", "the deb: apt owns it");
  assert.equal(updateSource("linux", { APPIMAGE: "" }), "release");
  assert.equal(updateSource("darwin", {}), "release", "unsigned, it cannot install itself");
  assert.equal(updateSource("darwin", { APPIMAGE: "/x" }), "release");
});

test("each platform looks for its own asset by the release's names", () => {
  assert.equal(releaseAssetName("0.5.1", "darwin", "arm64"), "raccoon-vtt-0.5.1-macos-arm64.dmg");
  assert.equal(releaseAssetName("0.5.1", "darwin", "x64"), "raccoon-vtt-0.5.1-macos-x64.dmg");
  assert.equal(releaseAssetName("0.5.1", "linux", "x64"), "raccoon-vtt_0.5.1_amd64.deb");
  assert.equal(releaseAssetName("0.5.1", "linux", "arm64"), "raccoon-vtt_0.5.1_arm64.deb");
  assert.equal(releaseAssetName("0.5.1", "win32", "x64"), null, "Windows reads latest.yml instead");
});

function release(tag: string, assets: string[], extra: Record<string, unknown> = {}) {
  return { tag_name: tag, html_url: `https://github.com/jwhitlow45/raccoon-vtt/releases/tag/${tag}`, assets: assets.map((name) => ({ name, size: 1 })), ...extra };
}

const MAC_AND_DEB = [
  "raccoon-vtt-0.5.1-macos-arm64.dmg",
  "raccoon-vtt-0.5.1-macos-x64.dmg",
  "raccoon-vtt_0.5.1_amd64.deb",
  "raccoon-vtt_0.5.1_arm64.deb",
  "raccoon-vtt-0.5.1-windows-x64-setup.exe",
];

test("a newer release with this computer's asset is offered on macOS and the deb", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
  ] as const) {
    assert.equal(releaseOffer(release("v0.5.1", MAC_AND_DEB), "0.5.0", platform, arch), "0.5.1", `${platform} ${arch}`);
  }
});

test("a release with no desktop assets yet, or none for this computer, is no update", () => {
  // A hosted-only release, or desktop.yml still uploading after image.yml made the release.
  const hostedOnly = release("v0.5.1", ["raccoon-vtt-0.5.1-compose.yml", "raccoon-vtt-0.5.1.sha256"]);
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["linux", "x64"],
  ] as const) {
    assert.equal(releaseOffer(hostedOnly, "0.5.0", platform, arch), null, `${platform}`);
  }
  assert.equal(releaseOffer(release("v0.5.1", ["raccoon-vtt-0.5.1-macos-arm64.dmg"]), "0.5.0", "darwin", "x64"), null, "the other Mac's");
  assert.equal(releaseOffer(release("v0.5.1", ["raccoon-vtt_0.5.1_arm64.deb"]), "0.5.0", "linux", "x64"), null, "the other deb's");
  assert.equal(releaseOffer(release("v0.5.1", ["raccoon-vtt-0.5.0-macos-arm64.dmg"]), "0.5.0", "darwin", "arm64"), null, "an older version's");
});

test("the same version, an older one, a prerelease and a draft are never offered", () => {
  const own = (v: string) => [`raccoon-vtt-${v}-macos-arm64.dmg`, `raccoon-vtt_${v}_amd64.deb`];
  assert.equal(releaseOffer(release("v0.5.0", own("0.5.0")), "0.5.0", "darwin", "arm64"), null, "the same version");
  assert.equal(releaseOffer(release("v0.4.9", own("0.4.9")), "0.5.0", "linux", "x64"), null, "an older version with its own assets");
  assert.equal(releaseOffer(release("v0.4.9", MAC_AND_DEB), "0.5.0", "darwin", "arm64"), null, "no downgrade");
  assert.equal(releaseOffer(release("v0.5.1-rc.1", MAC_AND_DEB), "0.5.0", "darwin", "arm64"), null);
  assert.equal(releaseOffer(release("v0.5.1", MAC_AND_DEB, { prerelease: true }), "0.5.0", "darwin", "arm64"), null);
  assert.equal(releaseOffer(release("v0.5.1", MAC_AND_DEB, { draft: true }), "0.5.0", "darwin", "arm64"), null);
  assert.equal(releaseOffer(release("nightly", MAC_AND_DEB), "0.5.0", "darwin", "arm64"), null);
});

test("a reply that is not a release throws, which the check logs as an error", () => {
  assert.throws(() => releaseOffer({ message: "API rate limit exceeded" }, "0.5.0", "darwin", "arm64"));
  assert.throws(() => releaseOffer(null, "0.5.0", "darwin", "arm64"));
});

test("versions compare by number, and a prerelease comes before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.5.0", "0.5.1"), -1);
  assert.equal(compareVersions("0.5.1", "0.5.1-rc.1"), 1);
  assert.equal(compareVersions("0.5.1-rc.1", "0.5.1"), -1);
  assert.equal(tagVersion("v1.2.3"), "1.2.3");
  assert.equal(tagVersion("1.2.3"), "1.2.3");
  assert.equal(tagVersion("v1.2"), null);
  assert.equal(tagVersion("v1.2.3-beta"), null);
});

test("the updater's no-assets, missing-feed and 404 failures are no update, logged at info, and anything else is an error", () => {
  const coded = (code: string, message = "x") => Object.assign(new Error(message), { code });
  // What electron-updater throws when the latest release has no latest.yml yet.
  assert.equal(updaterErrorLevel(coded("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "Cannot find latest.yml in the latest release artifacts")), "info");
  assert.equal(updaterErrorLevel(coded("ERR_UPDATER_NO_PUBLISHED_VERSIONS")), "info");
  assert.equal(updaterErrorLevel(coded("ERR_UPDATER_ASSET_NOT_FOUND")), "info");
  assert.equal(updaterErrorLevel(Object.assign(new Error("HttpError: 404"), { statusCode: 404 })), "info");
  assert.equal(
    updaterErrorLevel(coded("ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "Unable to find latest version on GitHub (...): HttpError: 404 \"method: GET url: ...\"")),
    "info",
  );
  assert.equal(
    updaterErrorLevel(coded("ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "Unable to find latest version on GitHub (...): net::ERR_INTERNET_DISCONNECTED")),
    "error",
    "a network failure inside the same code is an error",
  );
  assert.equal(updaterErrorLevel(coded("ERR_UPDATER_INVALID_UPDATE_INFO")), "error");
  assert.equal(updaterErrorLevel(Object.assign(new Error("HttpError: 500"), { statusCode: 500 })), "error");
  assert.equal(updaterErrorLevel(new Error("net::ERR_NAME_NOT_RESOLVED")), "error");
  assert.equal(updaterErrorLevel("weird"), "error");
});

test("GitHub gets only the request and a RaccoonVTT user agent, and Source code is this version's tag", () => {
  assert.equal(userAgent("0.5.0"), "RaccoonVTT/0.5.0");
  assert.equal(sourcePage("0.5.0"), "https://github.com/jwhitlow45/raccoon-vtt/releases/tag/v0.5.0");
});

test("the clock warning starts past 2 minutes either way", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  assert.equal(clockOffsetMinutes("Fri, 13 Nov 2026 12:00:00 GMT", now), null);
  assert.equal(clockOffsetMinutes("Fri, 13 Nov 2026 12:02:00 GMT", now), null, "exactly 2 minutes is fine");
  assert.equal(clockOffsetMinutes("Fri, 13 Nov 2026 12:02:01 GMT", now), 2);
  assert.equal(clockOffsetMinutes("Fri, 13 Nov 2026 11:53:00 GMT", now), 7, "a clock ahead");
  assert.equal(clockOffsetMinutes("Fri, 13 Nov 2026 12:07:00 GMT", now), 7, "a clock behind");
  assert.equal(clockOffsetMinutes(null, now), null);
  assert.equal(clockOffsetMinutes("yesterday", now), null);
});

// ---------------------------------------------------------------------------
// Install and restart

type Event = string;

function steps(over: Partial<InstallSteps> & { events: Event[]; stopResult?: () => Promise<{ ok: true } | { ok: false; reason: string }> }) {
  const updates: UpdateState[] = [];
  const s: InstallSteps = {
    download: async (onPercent) => {
      over.events.push("download");
      for (const p of [0, 10.4, 10.9, 55, 100]) onPercent(p);
    },
    stop: async () => {
      over.events.push("stop sent");
      const result = await (over.stopResult ?? (async () => ({ ok: true as const })))();
      over.events.push(`stopped ${result.ok}`);
      return result;
    },
    quitAndInstall: () => over.events.push("quitAndInstall"),
    setUpdate: (state) => updates.push(state),
    log: () => {},
    ...over,
  };
  return { s, updates };
}

test("Install and restart downloads, then waits for the supervisor's stopped report before the installer starts", { timeout: 5000 }, async () => {
  const events: Event[] = [];
  let reportStopped!: () => void;
  const stoppedReport = new Promise<void>((resolve) => (reportStopped = resolve));
  const { s, updates } = steps({
    events,
    stopResult: async () => {
      await stoppedReport;
      return { ok: true };
    },
  });
  const installing = new Installer(s).install("0.5.1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["download", "stop sent"], "nothing installs while the supervisor is still stopping");
  assert.deepEqual(updates.at(-1), { state: "stopping", version: "0.5.1" });
  reportStopped();
  assert.deepEqual(await installing, { ok: true, value: {} });
  assert.deepEqual(events, ["download", "stop sent", "stopped true", "quitAndInstall"]);
  assert.deepEqual(
    updates.map((u) => (u.state === "downloading" ? u.percent : u.state)),
    [0, 10, 55, 100, "stopping"],
    "whole percents, each shown once",
  );
});

test("a supervisor that does not stop leaves the old version running, and the banner offers the install again", { timeout: 5000 }, async () => {
  const events: Event[] = [];
  const { s, updates } = steps({ events, stopResult: async () => ({ ok: false, reason: "RaccoonVTT did not stop in time" }) });
  const result = await new Installer(s).install("0.5.1");
  assert.deepEqual(result, { ok: false, failure: { error: "failed", reason: "RaccoonVTT did not stop in time" } });
  assert.ok(!events.includes("quitAndInstall"));
  assert.deepEqual(updates.at(-1), { state: "available", version: "0.5.1", install: true });
});

test("a failed download never stops the supervisor", { timeout: 5000 }, async () => {
  const events: Event[] = [];
  const { s, updates } = steps({
    events,
    download: async () => {
      events.push("download");
      throw new Error("net::ERR_CONNECTION_RESET");
    },
  });
  const result = await new Installer(s).install("0.5.1");
  assert.equal(result.ok, false);
  assert.deepEqual(events, ["download"]);
  assert.deepEqual(updates.at(-1), { state: "available", version: "0.5.1", install: true });
});

test("a second press while installing is refused as busy", { timeout: 5000 }, async () => {
  const events: Event[] = [];
  let finish!: () => void;
  const { s } = steps({
    events,
    download: () => new Promise<void>((resolve) => (finish = resolve)),
  });
  const installer = new Installer(s);
  const first = installer.install("0.5.1");
  assert.deepEqual(await installer.install("0.5.1"), { ok: false, failure: { error: "busy" } });
  finish();
  assert.equal((await first).ok, true);
  assert.equal(events.filter((e) => e === "quitAndInstall").length, 1);
});
