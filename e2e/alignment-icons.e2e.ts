import { undoScopeAlignmentTests, alignmentFile, iconPassTests, musicPlayerAlignmentTests, noErrorsTest, roomTest } from "./alignmentRoom.ts";

/** FU39-C: the second icon pass in its own room (E2E-SPLIT), and the Music window's roots, first in a room with no sounds yet. */
alignmentFile("the second icon pass and the Music window", () => {
  roomTest();
  musicPlayerAlignmentTests();
  iconPassTests();
  undoScopeAlignmentTests(["390x844"]);
  noErrorsTest();
});
