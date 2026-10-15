import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { initials } from "../../lib/tokenView.ts";

/*
 * The board and the tracker draw a token's initials with lib/tokenView.ts
 * initials(): "AR" for Aria Rose, "GW" for a Goblin Warrior. The Characters
 * and Monsters panels drew the first two letters instead ("Ar", "Go"), so
 * one creature wore two labels (docs/design-v1-visual.md F12). These render
 * the panels' disks and check every panel file asks the one function.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Portrait } = await import("./CharactersPanel.tsx");
const { MonsterImageField } = await import("../monsters/MonsterImage.tsx");

/** Names whose first two letters differ from their initials, and a few that do not. */
const NAMES = ["Aria Rose", "Goblin Warrior", "Goblin Warrior 3", "Adult Red Dragon", "Thorn", "  Vex  "];

/** The text drawn on a disk with no picture: the innermost span's content. */
function diskText(markup: string): string {
  const texts = [...markup.matchAll(/>([^<>]+)</g)].map((m) => m[1]!);
  assert.equal(texts.length, 1, `one text on the disk: ${markup}`);
  return texts[0]!;
}

describe("one initials() everywhere a creature shows initials", () => {
  test("the board's initials for the names the screenshots show", () => {
    assert.equal(initials("Aria Rose"), "AR");
    assert.equal(initials("Goblin Warrior"), "GW");
  });

  test("the Characters panel's disk draws the board's initials", () => {
    for (const name of NAMES) {
      const markup = renderToStaticMarkup(createElement(Portrait, { character: { name }, size: 32 }));
      assert.equal(diskText(markup), initials(name), name);
    }
  });

  test("the monster image field, in the editor and on a stat block's page, draws the board's initials", () => {
    for (const name of NAMES) {
      const markup = renderToStaticMarkup(createElement(MonsterImageField, { value: undefined, onChange() {}, name }));
      // The field also holds its Set image button, so only the disk's span is read.
      const disk = /<span aria-hidden="true"[^>]*><span[^>]*>[^<]*<\/span><\/span>/.exec(markup)?.[0];
      assert.ok(disk, `a disk in ${markup}`);
      assert.equal(diskText(disk), initials(name), name);
    }
  });

  test("no panel file makes initials of its own from a name's first letters", () => {
    const files = ["./CharactersPanel.tsx", "./CharacterCard.tsx", "../monsters/MonsterEditor.tsx", "../monsters/MonsterImage.tsx"];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(source, /\.slice\(0, ?2\)/, `${file} slices a name`);
    }
    const card = readFileSync(new URL("./CharacterCard.tsx", import.meta.url), "utf8");
    assert.match(card, /import \{[^}]*\binitials\b[^}]*\} from "\.\.\/\.\.\/lib\/tokenView\.ts"/);
    assert.match(card, /initials=\{initials\(character\.name\)\}/, "the character card's portrait takes the board's initials");
  });
});
