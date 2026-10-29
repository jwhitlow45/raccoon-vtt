import { alignmentFile, isoChoiceTests, md4Tests, noErrorsTest, roomTest, sceneSettingsTests } from "./alignmentRoom.ts";

/** FU39-C: the builder, scene settings and view choice in its own room (E2E-SPLIT). */
alignmentFile("the builder, scene settings and view choice", () => {
  roomTest();
  md4Tests();
  sceneSettingsTests();
  isoChoiceTests();
  noErrorsTest();
});
