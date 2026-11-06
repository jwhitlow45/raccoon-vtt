import { undoSaveAlignmentTests, undoScopeAlignmentTests, alignmentFile, combatSmallTest, joinRequestAlignmentTests, noErrorsTest, panelSizeAlignmentTests, roomTest, sizeTests, someSizesTest } from "./alignmentRoom.ts";

/**
 * The alignment sweep at its wider windows (e2e/alignmentRoom.ts says what
 * it measures): a phone held sideways, the tablet and the desktop at 100%
 * and 130%, the combat controls at 480 x 320 at 130%, and the side panel's
 * tab row at its default width and its cap with a sheet's step arrows at
 * 700 x 900 with a mouse (docs/design/design-v1-panel-size.md 9), in a file
 * of its own so the CI shards can run it beside alignment.e2e.ts. It builds
 * its own room.
 */
alignmentFile("the sideways phone, the tablet, the desktop and 480 x 320", () => {
  roomTest();
  sizeTests(["844x390", "820x1180", "1440x900"]);
  combatSmallTest();
  someSizesTest("wide");
  undoScopeAlignmentTests(["1440x900", "844x390", "480x320"]);
  undoSaveAlignmentTests(["1440x900", "844x390", "480x320"]);
  joinRequestAlignmentTests(["1440x900"]);
  panelSizeAlignmentTests();
  noErrorsTest();
});
