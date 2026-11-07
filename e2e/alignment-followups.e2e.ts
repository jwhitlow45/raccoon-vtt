import { alignmentFile, fu30Tests, fu32Tests, grabberTests, iconFightTest, logHistoryTests, noErrorsTest, qolPanelTests, roomTest, toastsOverSheetTests } from "./alignmentRoom.ts";

/** FU39-C: follow-up batches 30 and 32, the app icon and the Sheet handle in its own room (E2E-SPLIT). */
alignmentFile("follow-up batches 30 and 32, the app icon and the Sheet handle", () => {
  roomTest();
  iconFightTest();
  fu30Tests();
  fu32Tests();
  grabberTests();
  logHistoryTests();
  toastsOverSheetTests();
  qolPanelTests();
  noErrorsTest();
});
