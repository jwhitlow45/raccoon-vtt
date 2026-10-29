import { alignmentFile, helperTest, noErrorsTest, restScrollsTest, roomTest, sizeTests, someSizesTest } from "./alignmentRoom.ts";

/**
 * The alignment sweep (e2e/alignmentRoom.ts says what it measures): the
 * helper on drawn cases, the upright phones at 100% and 130% and the
 * scrolling strip. The wider windows are in alignment-wide.e2e.ts and the
 * second icon pass in alignment-icons.e2e.ts. Follow-up roots and settings
 * run in alignment-followups.e2e.ts and alignment-settings.e2e.ts, so the
 * CI shards can run the five side by side. Each builds its own room.
 */
alignmentFile("the upright phones", () => {
  helperTest();
  roomTest();
  sizeTests(["390x844", "360x740", "320x568"]);
  restScrollsTest();
  someSizesTest("phones");
  noErrorsTest();
});
