import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor } from "vite";

const CLIENT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The client's words use the straight apostrophe, as the DM guide does, so
 * one text never mixes the two forms. Data text keeps its own form: SRD
 * names such as "Hunter’s Mark" come from shared/ and are not in the
 * client's source. A client file that holds data text of that kind goes
 * here, by its path under client/.
 */
const DATA_FILES = new Set<string>([]);

/**
 * Parsed rather than matched, so comments and regular expressions (the
 * search's own matchers fold both forms) are left out, while string
 * literals, template parts, JSX text and JSX attributes are read with their
 * escapes resolved, so a written-out ’ counts too.
 */
function curlyApostrophes(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors.map((e) => e.message), [], `${file} parses`);
  const found: string[] = [];
  const note = (start: number, text: string | null | undefined) => {
    if (text?.includes("’")) found.push(`${file}:${source.slice(0, start).split("\n").length}: ${text.trim().slice(0, 80)}`);
  };
  new Visitor({
    Literal(node) {
      if (typeof node.value === "string") note(node.start, node.value);
    },
    TemplateElement(node) {
      note(node.start, node.value.cooked ?? node.value.raw);
    },
    JSXText(node) {
      note(node.start, node.value);
    },
  }).visit(parsed.program);
  return found;
}

test("the client's strings and JSX text use straight apostrophes", () => {
  const files = readdirSync(CLIENT, { recursive: true, encoding: "utf8" })
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => /\.tsx?$/.test(f) && !/\.i?test\.ts$/.test(f) && !f.includes("node_modules") && !DATA_FILES.has(f));
  assert.ok(files.length > 100, "the scan found the client's source");
  const found = files.flatMap((file) => curlyApostrophes(file, readFileSync(path.join(CLIENT, file), "utf8")));
  assert.deepEqual(found, [], "use ' in the client's words, or list a data file in DATA_FILES");
});

test("the scan reads every place a word can stand and skips comments and patterns", () => {
  const source = [
    "// a comment’s words",
    "const pattern = /[‘’']/g;",
    'const plain = "one’s";',
    "const escaped = \"two\\u2019s\";",
    "const part = `${plain} three’s`;",
    'export const View = () => <p title="four’s">five’s {"six’s"}</p>;',
  ].join("\n");
  const found = curlyApostrophes("probe.tsx", source).map((line) => line.replace(/^probe\.tsx:\d+: /, ""));
  assert.deepEqual(found.sort(), ["five’s", "four’s", "one’s", "six’s", "three’s", "two’s"]);
});
