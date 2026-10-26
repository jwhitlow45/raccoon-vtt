import { readFileSync } from "node:fs";

/**
 * Which floating tags a release moves (.github/workflows/image.yml):
 *
 *   git tag -l | node scripts/release-tags.ts 0.1.2
 *
 * It prints TAG_LATEST=true or false and TAG_MINOR=true or false. A release
 * moves `latest` only while it is the highest vX.Y.Z tag of all, and `X.Y`
 * only while it is the highest of its minor release. So neither tag ever
 * moves back: not for a patch to an older minor, not for an older release
 * that finishes after a newer one, and not for a re-run of an older one.
 * Tags that are not exactly vX.Y.Z count for nothing. The list must hold
 * this release's own tag, which shows it was read after the tag was pushed.
 */

type Version = [number, number, number];

function parse(text: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function floatingTags(version: string, tags: readonly string[]): { latest: boolean; minor: boolean } {
  const self = parse(version);
  if (!self) throw new Error(`the version must be X.Y.Z, not ${JSON.stringify(version)}`);
  const released = tags.flatMap((t) => {
    const v = t.startsWith("v") ? parse(t.slice(1)) : null;
    return v ? [v] : [];
  });
  if (!released.some((v) => compare(v, self) === 0)) throw new Error(`the tag list has no v${version}`);
  const newer = released.filter((v) => compare(v, self) > 0);
  return { latest: newer.length === 0, minor: !newer.some((v) => v[0] === self[0] && v[1] === self[1]) };
}

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  const tags = readFileSync(0, "utf8").split("\n").map((t) => t.trim()).filter((t) => t !== "");
  const { latest, minor } = floatingTags(version, tags);
  console.log(`TAG_LATEST=${latest}`);
  console.log(`TAG_MINOR=${minor}`);
}
