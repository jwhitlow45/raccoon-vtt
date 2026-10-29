import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_OWN } from "./logic.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { OwnFields } = await import("./ResourceSheet.tsx");

test("FU38-B: the resource name takes its row's width without the browser's default input width", () => {
  const markup = renderToStaticMarkup(createElement(OwnFields, { draft: EMPTY_OWN, onChange() {} }));
  const input = /<input[^>]*aria-label="Name"[^>]*>/.exec(markup)?.[0];
  assert.ok(input);
  assert.match(input, /(?:;|\")width:0(?:;|\")/);
  assert.match(input, /flex:1/);
  assert.match(input, /min-width:0/);
});
