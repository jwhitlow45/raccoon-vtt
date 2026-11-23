import { alignmentFile, confirmMoreTests, noErrorsTest, roomTest } from "./alignmentRoom.ts";

/** LP49-CONFIRM-1: the armed confirms behind a tool's ⋯, in a room of their own so alignment-settings keeps its time (E2E-SPLIT). */
alignmentFile("armed confirms behind a tool's more", () => {
  roomTest();
  confirmMoreTests();
  noErrorsTest();
});
