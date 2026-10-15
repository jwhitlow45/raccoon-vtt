import type { AssetCredit, ImageCredit } from "#shared/protocol.ts";
import { cropSourceRect } from "../../lib/tokenView.ts";

/**
 * An openly licensed image's credit, as the library and the token panel show
 * it (docs/design-v1-dm-tools.md 3.13): the work and who made it, linked to
 * its page, its license, linked to the license, and what the app changed,
 * since Creative Commons licenses ask an adaptation to say so:
 *
 *   Goblins and a Troll by Dunechaser, CC BY-NC-SA 2.0. Resized and converted to WebP.
 *
 * Every import is re-encoded, so "converted to WebP" is always said.
 * "Resized" is said only when the stored image's size differs from the
 * original's, since the pipeline never enlarges and a small image keeps its
 * size. "Cropped." is added only where a token's crop shows less than the
 * whole image, so the credit names only changes actually made.
 */

/** Openverse's license codes, as Creative Commons writes their names. */
const LICENSE_NAMES: Record<string, string> = {
  by: "CC BY",
  "by-sa": "CC BY-SA",
  "by-nc": "CC BY-NC",
  "by-nc-sa": "CC BY-NC-SA",
  "by-nd": "CC BY-ND",
  "by-nc-nd": "CC BY-NC-ND",
  cc0: "CC0",
  pdm: "Public Domain Mark",
  "sampling+": "CC Sampling+",
  "nc-sampling+": "CC NC-Sampling+",
};

const VERSION = /^\d+\.\d+$/;

export function licenseName(code: string, version?: string): string {
  const name = LICENSE_NAMES[code] ?? code.toUpperCase();
  return version ? `${name} ${version}` : name;
}

/** The license's own page on creativecommons.org, or null when the code or version is not one it has. */
export function licenseUrl(code: string, version?: string): string | null {
  if (version !== undefined && !VERSION.test(version)) return null;
  if (code === "cc0") return `https://creativecommons.org/publicdomain/zero/${version ?? "1.0"}/`;
  if (code === "pdm") return `https://creativecommons.org/publicdomain/mark/${version ?? "1.0"}/`;
  if (!(code in LICENSE_NAMES) || !version) return null;
  return `https://creativecommons.org/licenses/${code}/${version}/`;
}

/** The work as the credit names it: "Title by Author", or whichever of the two it has. */
export function workName(credit: Pick<ImageCredit, "title" | "creator">): string {
  const title = credit.title?.trim();
  const creator = credit.creator?.trim();
  if (title && creator) return `${title} by ${creator}`;
  if (title) return title;
  if (creator) return `An image by ${creator}`;
  return "An untitled image";
}

/**
 * What the app changed. `stored` is the asset's own size. `crop` is a
 * token's crop with its footprint's width over height, for the token panel,
 * where the crop is part of the image as the token shows it.
 */
export function changesText(
  credit: Pick<AssetCredit, "originalWidth" | "originalHeight">,
  stored: { width: number; height: number },
  crop?: { crop: { cx: number; cy: number; zoom: number }; aspect: number },
): string {
  const resized = stored.width !== credit.originalWidth || stored.height !== credit.originalHeight;
  const sentence = resized ? "Resized and converted to WebP." : "Converted to WebP.";
  return crop && cropsImage(stored, crop.crop, crop.aspect) ? `${sentence} Cropped.` : sentence;
}

/** Whether a crop shows less than the whole image: a region smaller than it on either side, by more than rounding. */
export function cropsImage(image: { width: number; height: number }, crop: { cx: number; cy: number; zoom: number }, aspect: number): boolean {
  const shown = cropSourceRect(image, crop, aspect);
  return shown.width < image.width - 0.5 || shown.height < image.height - 0.5;
}

export type CreditParts = {
  work: string;
  /** The image's own page. Openverse gives http or https. */
  workUrl: string;
  license: string;
  licenseUrl: string | null;
  changes: string;
  /** The whole line as plain text. */
  text: string;
};

export function creditParts(credit: AssetCredit, stored: { width: number; height: number }, crop?: { crop: { cx: number; cy: number; zoom: number }; aspect: number }): CreditParts {
  const work = workName(credit);
  const license = licenseName(credit.license, credit.licenseVersion);
  const changes = changesText(credit, stored, crop);
  return {
    work,
    workUrl: credit.landingUrl,
    license,
    licenseUrl: licenseUrl(credit.license, credit.licenseVersion),
    changes,
    text: `${work}, ${license}. ${changes}`,
  };
}
