/**
 * Which floating tags a release moves (.github/workflows/image.yml):
 *
 *   node scripts/release-tags.ts 0.1.2 <what X.Y holds> <what latest holds>
 *
 * Each "holds" is the version label of the image that tag points to on
 * Docker Hub now, or `none` when the tag does not exist. A tag moves when it
 * does not exist or holds this release or an older one, so X.Y and latest
 * only ever move forward. Docker Hub says what is published, not the git
 * tags, so a tag whose release failed or was refused holds nothing back. It
 * prints TAG_MINOR and TAG_LATEST, true or false. Anything it cannot read as
 * X.Y.Z, or an X.Y that holds another minor release, fails: the workflow
 * then tags nothing rather than guess.
 */

type Version = [number, number, number];

function parse(text: string, what: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) throw new Error(`${what} must be X.Y.Z, not ${JSON.stringify(text)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Whether a floating tag that holds `held` (a version, or `none`) may move to `version`. */
export function moves(version: string, held: string): boolean {
  if (held === "none") return true;
  return compare(parse(held, "the version a tag holds"), parse(version, "the release")) <= 0;
}

export function floatingTags(version: string, minorHeld: string, latestHeld: string): { minor: boolean; latest: boolean } {
  const self = parse(version, "the release");
  if (minorHeld !== "none") {
    const held = parse(minorHeld, "the version X.Y holds");
    if (held[0] !== self[0] || held[1] !== self[1]) throw new Error(`${self[0]}.${self[1]} holds ${minorHeld}, which is not of that minor release`);
  }
  return { minor: moves(version, minorHeld), latest: moves(version, latestHeld) };
}

if (import.meta.main) {
  const [version = "", minorHeld = "", latestHeld = ""] = process.argv.slice(2);
  const { minor, latest } = floatingTags(version, minorHeld, latestHeld);
  console.log(`TAG_MINOR=${minor}`);
  console.log(`TAG_LATEST=${latest}`);
}
