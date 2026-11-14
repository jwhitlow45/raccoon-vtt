// The Electron fuses the shipped app is built with (design 6.6), shared by
// afterPack.mjs, which flips them, and the shell's e2e test, which checks
// a build carries them.
import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from "@electron/fuses";

/**
 * Off: running the app as plain Node (ELECTRON_RUN_AS_NODE), NODE_OPTIONS
 * and NODE_EXTRA_CA_CERTS, the --inspect arguments and SIGUSR1, and the
 * file:// protocol's extra privileges, so nothing outside the app can turn
 * it into a Node runtime or attach a debugger, and the window has no reason
 * to read files. On: cookie encryption, and loading the app only from
 * app.asar with its embedded integrity checked on macOS and Windows (Linux
 * has no such check and ignores the fuse).
 */
export const SHIPPED_FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

/** The fuses by name, for readable test messages. */
export const FUSE_NAMES = Object.fromEntries(Object.entries(FuseV1Options).filter(([, v]) => typeof v === "number").map(([k, v]) => [v, k]));

export async function flipShippedFuses(executable, resetAdHocDarwinSignature = false) {
  await flipFuses(executable, { version: FuseVersion.V1, resetAdHocDarwinSignature, ...SHIPPED_FUSES });
}

/**
 * For the e2e test only: turns the --inspect arguments back on in a copy of
 * a packed build, because Playwright drives Electron through Node's
 * inspector. Every other fuse stays as shipped.
 */
export async function allowInspectForTests(executable, resetAdHocDarwinSignature) {
  await flipFuses(executable, { version: FuseVersion.V1, resetAdHocDarwinSignature, [FuseV1Options.EnableNodeCliInspectArguments]: true });
}

/** Each shipped fuse whose state in `executable` differs, as "name: wanted, found" lines. */
export async function fuseDifferences(executable) {
  const wire = await getCurrentFuseWire(executable);
  const differences = [];
  for (const [index, wanted] of Object.entries(SHIPPED_FUSES)) {
    const found = wire[index];
    if ((found === FuseState.ENABLE) !== wanted) {
      const shown = found === FuseState.ENABLE ? "on" : found === FuseState.DISABLE ? "off" : String(found);
      differences.push(`${FUSE_NAMES[index]}: wanted ${wanted ? "on" : "off"}, found ${shown}`);
    }
  }
  return differences;
}
