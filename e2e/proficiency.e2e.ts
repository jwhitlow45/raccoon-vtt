import { alignmentFile, noErrorsTest, proficiencyTests, roomTest } from "./alignmentRoom.ts";

/** The FL-7 surfaces and marker geometry in both themes at every required size and scale. */
alignmentFile("FL-7 skill and saving throw proficiency", () => {
  roomTest();
  proficiencyTests();
  noErrorsTest();
});
