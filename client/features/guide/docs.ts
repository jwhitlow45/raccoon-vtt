import { GUIDE_PATH } from "./guide.ts";

/** The docs page's path. The page lists every written doc the app serves. */
export const DOCS_PATH = "/docs";

export type DocEntry = { path: string; title: string; description: string };

/**
 * Every written doc, in the order the Docs page lists them. A new doc is
 * one entry here and one route in lib/router.ts.
 */
export const DOCS: readonly DocEntry[] = [
  { path: GUIDE_PATH, title: "DM guide", description: "Building maps and running fights, step by step." },
];
