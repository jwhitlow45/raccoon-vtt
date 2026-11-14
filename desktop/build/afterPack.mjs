// electron-builder's afterPack hook: runs once every file of the app is in
// place, extraResources included, and before electron-builder signs it.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { flipShippedFuses } from "./fuses.mjs";

/** The app's own executable in the packed folder, by platform. */
function executable(context) {
  const name = context.packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case "darwin":
      return join(context.appOutDir, `${name}.app`, "Contents", "MacOS", name);
    case "win32":
      return join(context.appOutDir, `${name}.exe`);
    default:
      return join(context.appOutDir, context.packager.executableName);
  }
}

export default async function afterPack(context) {
  await flipShippedFuses(executable(context));
  // macOS with no signing identity (the unsigned preview, design 11.6): one
  // ad-hoc signature over the whole bundle, made after every binary is in
  // place, so Apple silicon runs it and the DM approves one seal with Open
  // Anyway. Flipping the fuses changed the executable, which also needs it.
  // With an identity, electron-builder signs right after this hook instead.
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (context.electronPlatformName === "darwin" && (identity === null || identity === undefined || identity === "-")) {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  }
}
