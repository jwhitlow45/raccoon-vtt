/**
 * The licenses the app's shipped art and data are used under, by id. It is
 * a module of its own, apart from shared/credits.ts, because the room's
 * code names an icon's license (client/features/images/icons.ts) and the
 * whole credit list, built when its module loads, belongs to the About
 * page's chunk alone.
 */

export type LicenseId = "CC0-1.0" | "CC-BY-3.0" | "CC-BY-4.0" | "CC-BY-SA-3.0" | "MIT" | "original";

export const LICENSES: Record<LicenseId, { name: string; url: string | null }> = {
  "CC0-1.0": { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  "CC-BY-3.0": { name: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/" },
  "CC-BY-4.0": { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  "CC-BY-SA-3.0": { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" },
  MIT: { name: "MIT License", url: "https://opensource.org/license/mit" },
  original: { name: "Made for RaccoonVTT", url: null },
};
