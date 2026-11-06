import { alignmentFile, clockTests, isoChoiceTests, md4Tests, noErrorsTest, panelGroupTests, roomTest, sceneSettingsTests } from "./alignmentRoom.ts";

/** FU39-C: the builder, scene settings, view choice and the folding panels in its own room (E2E-SPLIT). */
alignmentFile("the builder, scene settings and view choice", () => {
  roomTest();
  md4Tests();
  sceneSettingsTests();
  isoChoiceTests();
  clockTests();
  panelGroupTests();
  noErrorsTest();
});
