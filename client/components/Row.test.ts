import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement, isValidElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RowList, Row } = await import("./Row.tsx");

type Element = { key: string | null; props: { children: unknown } };

/** The list's items, as RowList returns them: each item's key and the key of the row inside it. */
function items(rows: string[]): { item: string | null; row: string | null }[] {
  const list = RowList({ children: rows.map((id) => createElement(Row, { key: id, title: id })) }) as unknown as Element;
  const lis = list.props.children as Element[];
  return lis.map((li) => ({ item: li.key, row: isValidElement(li.props.children) ? (li.props.children as Element).key : null }));
}

describe("RowList", () => {
  test("each item takes its row's key, so a row moves with its item when the list reorders", () => {
    const before = items(["a", "b", "c"]);
    const after = items(["c", "a", "b"]);
    for (const { item, row } of [...before, ...after]) assert.equal(item, row, "an item and its row share one key");
    const itemOf = (list: typeof before, row: string) => list.find((x) => x.row?.endsWith(row))?.item;
    for (const id of ["a", "b", "c"]) assert.equal(itemOf(after, id), itemOf(before, id), `row ${id} keeps its item`);
  });

  test("a row inserted at the top leaves the others' items as they were", () => {
    const before = items(["a", "b"]);
    const after = items(["z", "a", "b"]);
    assert.deepEqual(after.slice(1), before);
  });
});

describe("a row whose detail is told in full (docs/design-v1-resync.md 3.3)", () => {
  const summary = "3: Wisdom 16, D&D Beyond says 18, and 2 more";
  const html = (fullDetail: boolean) => renderToStaticMarkup(createElement(Row, { title: "Ability scores", detail: summary, expanded: false, fullDetail, onClick() {} }));

  test("is named by its title alone, and described by its detail, which wraps and is never cut", () => {
    const out = html(true);
    const labelled = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
    const described = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    assert.ok(labelled && described);
    assert.match(out, new RegExp(`<span id="${labelled}"[^>]*>Ability scores</span>`));
    assert.match(out, new RegExp(`<span id="${described}"[^>]*>${summary.replace("&", "&amp;")}</span>`));
    assert.match(out, /overflow-wrap:anywhere/);
    assert.doesNotMatch(out.slice(out.indexOf(`id="${described}"`)), /^[^>]*text-overflow:ellipsis/);
    assert.match(out, /aria-expanded="false"/);
  });

  test("a row without it keeps today's name, its whole text, and cuts its detail to one line", () => {
    const out = html(false);
    assert.doesNotMatch(out, /aria-labelledby|aria-describedby/);
    assert.match(out, /text-overflow:ellipsis/);
  });
});
