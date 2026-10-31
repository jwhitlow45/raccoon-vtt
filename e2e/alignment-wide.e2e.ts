import { undoSaveAlignmentTests, undoScopeAlignmentTests, alignmentFile, combatSmallTest, noErrorsTest, roomTest, sizeTests, someSizesTest } from "./alignmentRoom.ts";

/**
 * The alignment sweep at its wider windows (e2e/alignmentRoom.ts says what
 * it measures): a phone held sideways, the tablet and the desktop at 100%
 * and 130%, and the combat controls at 480 x 320 at 130%, in a file of its
 * own so the CI shards can run it beside alignment.e2e.ts. It builds its
 * own room.
 */
alignmentFile("the sideways phone, the tablet, the desktop and 480 x 320", () => {
  roomTest();
  sizeTests(["844x390", "820x1180", "1440x900"]);
  combatSmallTest();
  someSizesTest("wide");
  undoScopeAlignmentTests(["1440x900", "844x390", "480x320"]);
  undoSaveAlignmentTests(["1440x900", "844x390", "480x320"]);
  noErrorsTest();
});
