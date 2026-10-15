import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * Back from a journal page returns focus to its row, found by the row's
 * `data-opener` id (features/panels.ts useSubpageFocus). Found by its text
 * instead, the row was lost once reading the page dropped its New tag or a
 * rename changed its title, and of two pages with one title Back could land
 * on the other (review DATA-01).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PageRow } = await import("./JournalPanel.tsx");

function opener(props: { id: string; title: string; mark: "New" | "Updated" | null }): string | undefined {
  const markup = renderToStaticMarkup(createElement(PageRow, { ...props, detail: null, onOpen: () => {} }));
  return /data-opener="([^"]*)"/.exec(markup)?.[1];
}

describe("journal page rows as subpage openers", () => {
  test("a row's opener id is its page's, whatever its tag or title", () => {
    const read = opener({ id: "page01", title: "Rumors", mark: null });
    assert.equal(read, "journal-page01");
    assert.equal(opener({ id: "page01", title: "Rumors", mark: "New" }), read);
    assert.equal(opener({ id: "page01", title: "Rumors", mark: "Updated" }), read);
    assert.equal(opener({ id: "page01", title: "Rumors at the ford", mark: null }), read);
  });

  test("two pages with one title have two opener ids", () => {
    assert.notEqual(opener({ id: "page01", title: "Rumors", mark: null }), opener({ id: "page02", title: "Rumors", mark: null }));
  });
});
