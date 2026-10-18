import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { revealInScrollBox, scrollBox, startInScrollBox, visibleInScrollBox } from "./reveal.ts";

/**
 * A column 200 px tall that holds cards 100 px tall, 8 px apart, laid out
 * from an 8 px padding, with 8 px of scroll-padding at its head and 20 at
 * its foot, as the fight alerts column has. Screen positions follow the
 * column's scrollTop, as a browser's would.
 */
function column(cards: number) {
  const col = {
    parentElement: null,
    offsetParent: null,
    offsetTop: 60,
    offsetHeight: 200,
    scrollTop: 0,
    scrollHeight: 8 + cards * 108 + 20,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 60, bottom: 260, left: 0, right: 300 }),
  };
  const items = Array.from({ length: cards }, (_, i) => {
    const offsetTop = 8 + i * 108;
    return {
      parentElement: col,
      offsetParent: col,
      offsetTop,
      offsetHeight: 100,
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 100,
      getBoundingClientRect: () => ({ top: 60 + offsetTop - col.scrollTop, bottom: 160 + offsetTop - col.scrollTop, left: 0, right: 300 }),
    };
  });
  return { col, items };
}

const style = (el: unknown) =>
  el && (el as { clientHeight: number }).clientHeight === 200
    ? { overflowY: "auto", scrollPaddingTop: "8px", scrollPaddingBottom: "20px" }
    : { overflowY: "visible", scrollPaddingTop: "auto", scrollPaddingBottom: "auto" };

describe("bringing a card into view inside the column that scrolls it", () => {
  test("a card scrolled out above comes back to the head, clear of the scroll-padding", () => {
    const { col, items } = column(4);
    col.scrollTop = 300;
    assert.equal(visibleInScrollBox(items[0]!, style), false, "the first card is out of sight");
    revealInScrollBox(items[0]!, style);
    assert.equal(col.scrollTop, 0);
    assert.equal(visibleInScrollBox(items[0]!, style), true);
  });

  test("a card below comes up just far enough to clear the foot's scroll-padding", () => {
    const { col, items } = column(4);
    revealInScrollBox(items[2]!, style);
    // Its foot at 8 + 2 * 108 + 100 = 324, shown 20 px above the column's foot.
    assert.equal(col.scrollTop, 324 - 200 + 20);
    assert.equal(visibleInScrollBox(items[2]!, style), true);
  });

  test("a card already in view stays where it is", () => {
    const { col, items } = column(4);
    col.scrollTop = 100;
    revealInScrollBox(items[1]!, style);
    assert.equal(col.scrollTop, 100);
  });

  test("an element in no box that scrolls is shown as it is", () => {
    const { items } = column(1);
    assert.equal(scrollBox(items[0]!, style), null, "a column with room for all it holds does not scroll");
    assert.equal(visibleInScrollBox(items[0]!, style), true);
  });
});

describe("opening a panel on one of its sections (LP7-DICE-6)", () => {
  test("the section starts its margin below the box's head, the box stopping at its end", () => {
    const { col, items } = column(4);
    startInScrollBox(items[2]!, 48, false, style);
    assert.equal(col.scrollTop, 8 + 2 * 108 - 48);
    startInScrollBox(items[3]!, 48, false, style);
    assert.equal(col.scrollTop, col.scrollHeight - col.clientHeight, "as far as the box goes, and no further");
  });

  test("under the interface size's zoom the distance on screen is read back in the box's own pixels", () => {
    const { col, items } = column(4);
    // Drawn at 130%: the column 260 px tall on screen for its 200, each card where 1.3 times its offset puts it.
    col.getBoundingClientRect = () => ({ top: 60, bottom: 320, left: 0, right: 390 });
    const card = items[2]!;
    card.getBoundingClientRect = () => ({ top: 60 + (card.offsetTop - col.scrollTop) * 1.3, bottom: 190 + (card.offsetTop - col.scrollTop) * 1.3, left: 0, right: 390 });
    col.scrollTop = 20;
    startInScrollBox(card, 48, false, style);
    assert.equal(Math.round(col.scrollTop), 8 + 2 * 108 - 48);
  });
});
