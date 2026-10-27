import { alignmentFile, fu30Tests, fu32Tests, grabberTests, iconPassTests, isoChoiceTests, md4Tests, noErrorsTest, roomTest } from "./alignmentRoom.ts";

/**
 * The alignment sweep's second icon pass, follow-up batch 30's roots,
 * whose round header steps run in the icon pass's fight, the app icon's
 * places, follow-up batch 32's roots, This device's Sheet handle, map
 * discovery's builder note and forget question and the isometric view's choice
 * (e2e/alignmentRoom.ts says what they measure),
 * in a file of its own so the CI shards can run it beside
 * alignment.e2e.ts. It builds its own room.
 * The view choice's step runs last, since the page it opens offers
 * Isometric from then on.
 */
alignmentFile("the second icon pass, follow-up batches 30 and 32, the app icon, the Sheet handle, the builder's note and question and the view choice", () => {
  roomTest();
  iconPassTests();
  noErrorsTest();
  fu30Tests();
  fu32Tests();
  grabberTests();
  md4Tests();
  isoChoiceTests();
});
