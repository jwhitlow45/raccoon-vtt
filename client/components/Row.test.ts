import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement, isValidElement } = await import("react");
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
