import { LINK_WORDS, fallDice, fallDrop, landingShift, throughOpening } from "#shared/rules/floorLinks.ts";

/*
 * The client's phase 4 tests (docs/design/design-v1-floors.md phase 4) read
 * rules the rules lane builds over the contract's stubs: fallDrop,
 * fallDice, throughOpening, landingShift and the opening's own words. Until
 * a stub is filled, a test that needs it is skipped with its name, so the
 * client lane checks clean on the contract alone and runs every such test
 * once it stacks on the rules. Only a stub's own "not built" throw counts
 * as waiting: anything else, a throw from a built rule given the probe's
 * placeholder arguments too, counts as built, so the test runs and a
 * broken rule fails it rather than hiding behind the skip.
 */

function waits(name: string, run: () => unknown): string | false {
  try {
    run();
    return false;
  } catch (e) {
    return e instanceof Error && e.message.startsWith("not built") ? `waits on the rules lane's ${name}` : false;
  }
}

/** A test's `skip` while the rule it reads is a stub, else false. */
export const WAITS = {
  fallDrop: waits("fallDrop", () => fallDrop(10, 0, 0)),
  fallDice: waits("fallDice", () => fallDice(10)),
  landingShift: waits("landingShift", () => landingShift({ rect: { x: 0, y: 0, w: 1, h: 1 } }, { rect: { x: 0, y: 0, w: 1, h: 1 } })),
  // A stub throws before it reads anything, so any arguments tell.
  throughOpening: waits("throughOpening", () => throughOpening(undefined as never, undefined as never, undefined as never, undefined as never)),
  /** LINK_WORDS reads an opening's own words (KIND_WORDS) rather than a ladder's. */
  openingWords: LINK_WORDS.tooBig("opening").includes("opening") ? false : "waits on the rules lane's KIND_WORDS",
} as const;
