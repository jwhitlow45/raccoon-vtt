import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * An icon-only tab first took its panel's title as its `aria-label`, which
 * replaced the badge's hidden words: "Log 2 unread" was read as "Log"
 * (ICONS2-ASTRA-03). Its name is a hidden title beside the badge instead,
 * as a named tab's is its text beside the badge.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PanelTab } = await import("./SideTabs.tsx");
const { Badge } = await import("./RoomChrome.tsx");
const { panelById } = await import("../features/panels.ts");

/** The words a screen reader reads as the tab's name: its text, less what is hidden from it. */
function spokenName(markup: string): string {
  const tab = /<button[^>]*role="tab"[^>]*>([\s\S]*)<\/button>/.exec(markup)?.[1] ?? "";
  let text = tab;
  // Innermost first, so a hidden span inside a hidden span goes with it.
  for (let i = 0; i < 5; i++) text = text.replace(/<(span|svg)[^>]*aria-hidden="true"[^>]*>(?:(?!<\1)[\s\S])*?<\/\1>/g, "");
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tab(id: string, alone: boolean, count: number, label?: string): string {
  const panel = panelById(id);
  assert.ok(panel);
  return renderToStaticMarkup(
    createElement(PanelTab, {
      panel,
      alone,
      tabRef: undefined,
      id: `tab-${id}`,
      chosen: false,
      controls: undefined,
      describedBy: undefined,
      stop: false,
      index: 0,
      onClick: () => {},
      style: {},
      children: createElement(Badge, { count, corner: true, ...(label ? { label } : null) }),
    }),
  );
}

describe("a panel's tab, its icon alone", () => {
  test("keeps the badge's unread count in its name, as the tab with its name does", () => {
    const alone = tab("log", true, 2);
    assert.doesNotMatch(alone, /aria-label=/, "no label that would replace the badge's words");
    assert.equal(spokenName(alone), "Log 2 unread");
    assert.equal(spokenName(tab("log", false, 2)), "Log 2 unread");
  });

  test("keeps a badge's own label in its name", () => {
    assert.equal(spokenName(tab("dm", true, 1, "1 upload waiting")), "DM 1 upload waiting");
  });

  test("is named by its title alone with no badge", () => {
    assert.equal(spokenName(tab("tracker", true, 0)), "Initiative");
  });
});
