# raccoon-vtt v1: the DM guide looks like a printed guide

Status: built for review. The screenshots go to the project owner before tests and review. Section 10 lists the owner's choices with a recommended answer for each. This design builds on the DM guide's page (`client/pages/DmGuide.tsx`), the Docs page (`client/pages/Docs.tsx`) and the shared Markdown renderer (`client/components/markdown.ts`, `Markdown.tsx`), and keeps the visual design's tokens (docs/design-v1-visual.md).

The project owner asked on 2026-10-18: "could the formatting of the dm guide be "spruced" up a little bit? I feel text hierarchies could be made a bit more clear and the TOC could be a bit more "official" looking/be a bit more bespoke instead of just being a basic list. open to ideas here i just want the guide to look more "professional"".

## 1. Summary

- **A title block**: a "RaccoonVTT documentation" label, the guide's name at 40 px, its one-line subtitle, and the introduction set as a lead at 18 px.
- **A contents built from the headings**: "Start here" cards for the opening sections, each with its first sentence, then a card per part with its number, its name, the first sentence of its introduction and its numbered sections. It takes the markdown contents list's place, and GitHub keeps the list.
- **Parts open like chapters**: a rule, a "Part 2" label, the name at 32 px, a short accent bar, and the part's introduction as a lead. Sections carry their number ("2.5 Initiative") at 24 px. Subsections stay unnumbered at 18 px.
- **Reading measure**: body text at 16 px with a line height of 1.6, kept to 34 em (a median of 73 characters a line). Figures take the column's full 720 px.
- **Procedures as steps**, **keys as keycaps**, **screenshots as framed figures with captions**, and **Tip and Note callouts** from GitHub's alert syntax.
- **Worked examples set apart**: each scenario opens with a banner holding an "Example 4.1" label, its title and its premise, and its "Building it" and "Running it" labels read as small capitals.
- **Navigation**: a sticky outline beside the text on a wide screen that marks the section being read, the Contents button's sheet on a phone with the same outline, and at each part's end "Back to contents" and "Next: part 3".
- **The Docs page** wears the same top bar and title block, and its entry becomes a card.
- No data, protocol, route or stored key changes. Journal pages and stat blocks render exactly as before.

## 2. Today

The page is the markdown drawn with the journal's renderer and a few additions: every heading the same weight with a 1 px rule under it, the body at 16 px across a 760 px column (about 100 characters a line), numbered lists as plain browser lists, `code` as grey chips, screenshots as bare images, and the contents as a two-level bullet list. Parts (`#`) and sections (`##`) differ only by 2 px. Nothing marks where the reader is on a 900-line page, and the floating Contents button jumps back to the list.

## 3. The outline (features/guide/outline.ts)

`guideOutline(blocks)` reads the parsed guide into a book:

- `intro`: the blocks before `## Contents`.
- The `## Contents` section's blocks are dropped. The page draws its own contents under the same id, so `#contents` still lands there.
- `opening`: the `##` sections before the first `#` part, unnumbered.
- `parts`: each `#` heading, numbered from 1, with its `intro` (the blocks before its first `##`), a `summary` (the intro's first sentence as plain text), and its `sections`, numbered "part.n". Each section's `body` runs to the next `##` or `#` and keeps its `###` subsections.
- The part whose id is `scenarios` is the part of worked examples. Heading ids are fixed, since Guide links open them, so the page keys on the id rather than a new markup.

Numbers are drawn by the page, never typed into the heading text, so every id stays the slug GitHub gives the heading. They are `aria-hidden`: a screen reader hears the heading's own words, as the Guide links name them.

Rejected: building the contents from the markdown `## Contents` list. It would drift whenever a heading is added and the list is not.

## 4. Layout

| Width (layout px) | Layout |
|---|---|
| 1064 and up | Outline (240) beside the column (720), 56 px apart, the pair centered |
| Under 1064 | The column alone, up to 720, with the floating Contents button |
| Phone, 390 | The column at 358 with a 16 px gutter, no sideways scroll |

The breakpoint uses `useLayoutSize` (features/device/layout.ts), so a device's interface size counts. The top bar (crest, "RaccoonVTT Docs", All docs and Home) spans both columns.

## 5. Type and spacing

| Element | Size | Weight | Space above | Notes |
|---|---|---|---|---|
| Guide title (h1) | 40 | 700 | 40 | line height 1.1 |
| Subtitle | 20 | 400 | 12 | muted |
| Lead (introductions) | 18 | 400 | 24 | line height 1.55 |
| Part (h2) | 32 | 700 | 96, then a rule and 32 | "Part n" label in accent small capitals, a 40 x 3 accent bar under it |
| Section (h3) | 24 | 700 | 56 | its number in the accent before it |
| Subsection (h4) | 18 | 700 | 32 | no rule |
| Label paragraph | 13 | 700 | 32 | a paragraph that is only bold text, in accent small capitals |
| Body | 16 | 400 | 0, 16 after | line height 1.6, measure 34 em |
| Caption | 13 | 400 | 8 | muted |

Every heading's 1 px rule goes: space and size carry the ladder, and the rules made every level look alike. The type is `theme.font.body`, so Inter applies when the font lane lands. The sizes above the interface's (40, 32) are named in one place each: `DOC_TITLE_SIZE` in features/guide/look.ts and `GUIDE_HEADING` in Markdown.tsx.

The measure was checked in Chrome on a Mac over every full line of the guide's paragraphs: at 34 em the median line holds 73 characters (67 to 77 for the middle 80%). At 36 em the median was 77 (71 to 82).

## 6. The renderer's guide look (components/Markdown.tsx)

All of it sits behind `guide`. `MarkdownBlocks` renders blocks already parsed, for the page that lays out the parts itself.

- **Steps.** A numbered list draws each number in a 26 px disc, joined to the next by a 2 px line, with 12 px between steps. The `ol` keeps `role="list"`, which Safari drops from a list without markers, and the number stays text, so a screen reader says it.
- **Keys.** A code span that names a key is drawn as keycaps in `kbd`: one character (`N`, `?`, `0`), a key's name (`Escape`, `Page Up`) or a chord (`Ctrl+Shift+Z`, drawn as three caps joined by "+"). `keyChord` in markdown.ts decides, so the parser stays a tree. Anything else (`goblin`, `8d6 fire`, `-7`, a file name) stays code. Control names stay bold.
- **Figures.** An image becomes a `figure`: a 1 px border, a 16 px radius, the surface as a mat (8 px, or 16 around a phone's screenshot), and the alt text as a visible caption. The caption is `aria-hidden`, since the alt text says the same to a screen reader. A portrait screenshot is at most 300 px wide, so it fits a window's height. The width and height attributes stay, so the page still reserves each image's place before it loads.
- **Callouts.** `> [!TIP]` and `> [!NOTE]` (section 7) draw a box on the surface with a 3 px stripe at its left and a label: Tip in the accent, Note in the blue of `ally` (5.0:1 on the surface). It has `role="note"`. No icon: main's icon set has none that fits, and the label reads plainly.
- **Label paragraphs.** A paragraph of bold text alone ("**Building it**") reads as a label in accent small capitals.
- **Lists** keep 8 px between items, and quotes keep the journal's look.

Tables, which the guide does not use, render as before.

## 7. The parser's addition (components/markdown.ts)

Behind `guide` only, at the top level only: a quote whose first line is `[!TIP]` or `[!NOTE]` alone (any case) becomes `{ kind: "quote", alert: "tip" | "note", blocks }` from its remaining lines. GitHub reads the same quote as an alert, so both renderings match. A marker with nothing after it, a marker inside another quote, GitHub's other three kinds, and any journal quote stay plain quotes that show the marker. An optional field on the quote block keeps every other consumer of the tree unchanged.

## 8. Navigation

- **The outline** (`GuideOutlineNav`, a `nav` named "Guide outline"): the opening sections, then each part with its number. Beside the text it opens only the part being read, so it fits the window, and it scrolls itself, never the page, to keep the current row in view. In the phone's sheet every part is open.
- **Where you are** (`useCurrentSection`): the last heading whose top has passed a line a third of the way down the window (at most 240 px), or the last one in view at the page's foot. It reads on scroll at most once a frame and renders only when the answer changes. The current row gets `aria-current="location"`, a 2 px accent bar and the raised surface.
- **Row height**: 44 px for a finger and in the sheet, 32 px with a mouse beside the text, where 44 px rows would push a part's eleven sections past an 800 px window. It follows `isFinePointer`, as the token window's handle does.
- **The phone's sheet** is the shared `Dialog` in its sheet shape, named "Contents". A row closes it, scrolls the page to the heading, pushes the hash so Back returns, and focuses the heading (each part and section heading has `tabIndex={-1}`). Escape and a swipe close it as any sheet.
- **Part ends**: two cards, "Back to contents" and "Next: part n" with the next part's name, each at least 44 px.
- **Unchanged**: the hash scroll on load, in-page links, and the Guide links from panels.
- No smooth scrolling and no new animation, so reduced motion needs nothing.

Rejected: a second "On this page" list of subsections on the right. Sections are short, and a third column squeezes the measure on a 1280 window.

## 9. Writer's conventions (docs/dm-guide.md)

The prose lane already follows these:

1. `> [!TIP]` and `> [!NOTE]` on a quote's first line, then the quote's text. Sparingly.
2. One or two sentences under each part heading. The contents shows the first sentence, so it should stand alone as the part's description.
3. No HTML, and heading ids stay.

Two more, which the guide mostly does already:

4. A key goes in backticks (`` `N` ``, `` `Ctrl+Z` ``), so it becomes a keycap. A word in backticks that is not a key stays code.
5. A label over steps, such as a scenario's "**Building it**", is a paragraph of bold text alone.

**Asked of the writer**: put `# Reference` and a one-sentence introduction before `## Shortcuts`. Today Shortcuts sits under `# Scenarios`, on GitHub too, so the page numbers it 4.8 and draws it as a worked example. The screenshots use a fixture copy with that heading. The `shortcuts` id does not change.

## 10. For the project owner

| Question | Recommendation |
|---|---|
| Serif headings? A screenshot shows Source Serif 4 (OFL) for the title, parts, sections and the contents' titles, loaded for the shot only. | Keep the one sans font. Inter alone reads clean beside the app, and a second face means a second file to bundle and credit. |
| Captions under screenshots (the alt text, shown) | Keep. They read like a printed guide's figures. The cost is length. |
| "Start here" cards for the three opening sections | Keep. They point a new DM at the Quick start first. |
| Light mode | The app has one dark theme (a light theme is a Later item in docs/features.md), so the page has one too. Every color is a token, so it follows a light theme when one comes. |

## 11. What must not change

- Heading ids and the hash scroll on load, the Guide links from panels and `#contents`.
- The image size reservations.
- The parser stays a tree builder that emits no HTML. Journal pages and stat blocks render as before.
- Theme tokens only (style drift check), no new dependency, no sideways scroll at 390 px.

## 12. Tests (the next stage)

- **Unit** (markdown.test.ts): alerts parse behind `guide` only, at the top level only, need a body, and other kinds stay quotes. `keyChord` takes single characters, named keys and chords, and leaves `-7`, `goblin`, `Ctrl++` and `cr 1-3` as code.
- **Unit** (new outline.test.ts, on the real guide): every part and section has an id and a number, the contents is dropped, the scenarios part is the examples part, every heading the Guide links open is in the outline, `firstSentence` cuts where it should, and `currentOf` picks the right heading above the first, mid-page and at the foot.
- **e2e** (`e2e/guide.e2e.ts`): the phone's Contents is now a button that opens a sheet, so its step changes. New steps (labelled `guidelook-`): on a computer the outline marks the section after a jump and a scroll, on a phone a row in the sheet closes it, lands on its heading and Back returns, rows meet 44 px on touch, and the Docs page still links the guide.

## 13. FEATURES.md

A line under the DM guide's entry: the contents, the outline that follows your place, steps, keycaps and callouts. It goes in the lane's last commit.

## 14. Files

| File | Change |
|---|---|
| client/components/markdown.ts | Alerts, `keyChord` |
| client/components/Markdown.tsx | `MarkdownBlocks`, the guide look, `GUIDE_HEADING` |
| client/features/guide/outline.ts | New: the outline |
| client/features/guide/useCurrentSection.ts | New: where the reader is |
| client/features/guide/GuideContents.tsx | New: the contents and the outline |
| client/features/guide/GuideDocument.tsx | New: the lead, part openers, sections, examples, part ends |
| client/features/guide/DocsHeader.tsx, look.ts | New: the top bar and title block both docs pages share |
| client/pages/DmGuide.tsx | The page's layout, the outline and the sheet |
| client/pages/Docs.tsx | The shared top bar and title block, the entry as a card |

## Appendix: screenshots

In the project owner's screenshot folder under `raccoon-vtt/guide-look/`: `before-*` from the Docs page commits (main's guide text), `after-*` from this build with the revised text and the `# Reference` heading, `after-realtext-*` with the revised text as committed, and `serif-*` for the serif option.
