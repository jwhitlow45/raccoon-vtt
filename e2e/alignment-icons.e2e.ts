import { alignmentFile, iconPassTests, noErrorsTest, roomTest } from "./alignmentRoom.ts";

/** FU39-C: the second icon pass in its own room (E2E-SPLIT). */
alignmentFile("the second icon pass", () => {
  roomTest();
  iconPassTests();
  noErrorsTest();
});
