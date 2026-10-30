/**
 * Server markup with each proficiency unit's frame taken out
 * (components/ProficiencyMark.tsx): a unit framing a name and its bonus
 * leaves its words in place, and a name or a button that draws its own
 * frame loses the attributes and the style that draw it. A test reads the
 * words and layout as they were before the marks, and the label spans
 * that name the level stay. ProficiencyMark.test.ts checks the frames.
 */
export function withoutFrames(markup: string): string {
  let out = markup;
  for (;;) {
    const open = /<span data-proficiency-mark="\w+" data-proficiency-form="unit" style="[^"]*">/.exec(out);
    if (!open) break;
    let depth = 1;
    let at = open.index + open[0].length;
    const tags = /<span[\s>]|<\/span>/g;
    tags.lastIndex = at;
    for (let tag = tags.exec(out); tag; tag = tags.exec(out)) {
      depth += tag[0] === "</span>" ? -1 : 1;
      if (depth === 0) {
        at = tag.index;
        break;
      }
    }
    out = out.slice(0, open.index) + out.slice(open.index + open[0].length, at) + out.slice(at + "</span>".length);
  }
  return out
    .replace(/ data-proficiency-mark="\w+" data-proficiency-form="\w+"/g, "")
    .replace(/(<span data-proficiency-label="" data-proficiency-level="\w+" title="\w+") style="[^"]*"/g, "$1")
    .replace(/border-color:currentColor;box-shadow:inset 0 0 0 1px currentColor;/g, "")
    .replace(/border-color:currentColor;box-shadow:inset 0 0 0 2px [^;"]*, inset 0 0 0 3px currentColor;/g, "");
}
