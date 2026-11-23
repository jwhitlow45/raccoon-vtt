import { alignmentFile, clockTests, confirmMoreTests, isoChoiceTests, md4Tests, noErrorsTest, panelGroupTests, qolBarTests, roomTest, sceneSettingsTests } from "./alignmentRoom.ts";

/** FU39-C: the builder, scene settings, view choice and the folding panels in its own room (E2E-SPLIT). */
alignmentFile("the builder, scene settings and view choice", () => {
  roomTest();
  md4Tests();
  confirmMoreTests();
  sceneSettingsTests();
  isoChoiceTests();
  clockTests();
  panelGroupTests();
  qolBarTests();
  noErrorsTest();
});
