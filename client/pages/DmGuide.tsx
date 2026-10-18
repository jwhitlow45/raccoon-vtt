import { useEffect, useLayoutEffect, useRef, useState } from "react";
import GUIDE from "../../docs/dm-guide.md?raw";
import { Button } from "../components/Button.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { type MarkdownImage } from "../components/Markdown.tsx";
import { parseMarkdown } from "../components/markdown.ts";
import { useLayoutSize } from "../features/device/layout.ts";
import { DOCS, DOCS_PATH } from "../features/guide/docs.ts";
import { DocsTopBar, DocTitle } from "../features/guide/DocsHeader.tsx";
import { GuideContents, GuideOutlineNav } from "../features/guide/GuideContents.tsx";
import { GuideLead, GuidePartView, GuideSectionView } from "../features/guide/GuideDocument.tsx";
import { GUIDE_PATH, guideBody, guideImageName, guideImageSize } from "../features/guide/guide.ts";
import { CONTENTS_ID, guideOutline, outlineIds } from "../features/guide/outline.ts";
import { useCurrentSection } from "../features/guide/useCurrentSection.ts";
import { navigate } from "../lib/navigation.ts";
import { theme } from "../lib/theme.ts";
import { APP_TITLE } from "../lib/title.ts";

/*
 * Every screenshot becomes a file of the build with a hashed name, so the
 * page reads nothing from disk at request time and the CSP's img-src 'self'
 * already covers them. Each loads only as the reader nears it.
 */
const IMAGES = import.meta.glob<string>("../../docs/dm-guide/*.webp", { eager: true, query: "?url", import: "default" });

function image(src: string): MarkdownImage | null {
  const name = guideImageName(src);
  const url = name ? IMAGES[`../../docs/dm-guide/${name}`] : undefined;
  return name && url ? { url, ...guideImageSize(name) } : null;
}

const OUTLINE = guideOutline(parseMarkdown(guideBody(GUIDE), { guide: true }));
const IDS = outlineIds(OUTLINE);
const SUBTITLE = DOCS.find((d) => d.path === GUIDE_PATH)?.description ?? "";

/** The text's column: body text keeps to its measure inside it, and figures take all of it (components/Markdown.tsx). */
const COLUMN = 720;
const OUTLINE_WIDTH = 240;
const OUTLINE_GAP = theme.space(14);
/** From this layout width the outline stands beside the text. Narrower, the Contents button opens it as a sheet. */
const OUTLINE_MIN_WIDTH = COLUMN + OUTLINE_GAP + OUTLINE_WIDTH + theme.space(12);

/**
 * The DM guide at /docs/dm-guide, for anyone, signed in or not. It is the
 * repository's docs/dm-guide.md, drawn as a printed guide
 * (docs/design-v1-guide-look.md): a title, a contents of numbered parts
 * and sections built from the headings (features/guide/outline.ts), and
 * each part opening like a chapter. Each heading has the id GitHub gives
 * it, so /docs/dm-guide#areas opens on Areas here and on GitHub alike.
 *
 * On a wide screen an outline stands beside the text and marks the
 * section being read. Narrower, a Contents button opens it as a sheet.
 */
export default function DmGuide() {
  useEffect(() => {
    document.title = `${APP_TITLE} · DM guide`;
    return () => {
      document.title = APP_TITLE;
    };
  }, []);

  // The browser looks for the section before this chunk has drawn the page, so a link or a reload with one finds nothing. The page goes there itself once drawn. Later jumps inside the page are the browser's own.
  useLayoutEffect(() => {
    const id = sectionOf(location.hash);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  const wide = useLayoutSize().width >= OUTLINE_MIN_WIDTH;
  const current = useCurrentSection(IDS);
  const [sheet, setSheet] = useState(false);
  const chosen = useRef<HTMLElement | null>(null);

  const article = (
    <article style={{ minWidth: 0, fontSize: theme.font.input, lineHeight: 1.6, overflowWrap: "anywhere" }}>
      <DocTitle label="RaccoonVTT documentation" title="DM guide" subtitle={SUBTITLE} />
      <GuideLead blocks={OUTLINE.intro} image={image} />
      <GuideContents outline={OUTLINE} />
      {OUTLINE.opening.map((section) => (
        <GuideSectionView key={section.id} section={section} image={image} />
      ))}
      {OUTLINE.parts.map((part, i) => (
        <GuidePartView key={part.id} part={part} next={OUTLINE.parts[i + 1] ?? null} image={image} />
      ))}
    </article>
  );

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        padding: `calc(${theme.safe.top} + ${theme.space(4)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(24)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: wide ? OUTLINE_WIDTH + OUTLINE_GAP + COLUMN : COLUMN, margin: "0 auto" }}>
        <DocsTopBar
          actions={
            <>
              <Button size="sm" onClick={() => navigate(DOCS_PATH)}>
                All docs
              </Button>
              <Button size="sm" onClick={() => navigate("/")}>
                Home
              </Button>
            </>
          }
        />
        {wide ? (
          <div style={{ display: "grid", gridTemplateColumns: `${OUTLINE_WIDTH}px minmax(0, ${COLUMN}px)`, columnGap: OUTLINE_GAP, alignItems: "start" }}>
            {/* It scrolls on its own when a part's sections run past the window, and keeps the place being read in view. */}
            <aside style={{ position: "sticky", top: 0, maxHeight: "100dvh", overflowY: "auto", padding: `${theme.space(10)}px ${theme.space(1)}px ${theme.space(6)}px` }}>
              <GuideOutlineNav
                outline={OUTLINE}
                current={current}
                all={false}
                header={
                  <a
                    href={`#${CONTENTS_ID}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      minHeight: theme.space(8),
                      fontSize: theme.font.small,
                      fontWeight: theme.weight.bold,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: theme.color.textMuted,
                      textDecoration: "none",
                    }}
                  >
                    Contents
                  </a>
                }
              />
            </aside>
            {article}
          </div>
        ) : (
          article
        )}
      </div>
      {wide ? null : (
        // The way around a long page stays one tap away from anywhere in it.
        <button
          type="button"
          onClick={() => setSheet(true)}
          aria-haspopup="dialog"
          style={{
            position: "fixed",
            right: `calc(${theme.safe.right} + ${theme.space(4)}px)`,
            bottom: `calc(${theme.safe.bottom} + ${theme.space(4)}px)`,
            display: "inline-flex",
            alignItems: "center",
            minHeight: theme.touch,
            padding: `0 ${theme.space(4)}px`,
            borderRadius: theme.radius.pill,
            background: theme.color.surfaceRaised,
            border: `${theme.line.border}px solid ${theme.color.border}`,
            boxShadow: theme.shadow.float,
            color: theme.color.text,
            font: "inherit",
            fontSize: theme.font.body14,
            fontWeight: theme.weight.strong,
          }}
        >
          Contents
        </button>
      )}
      {sheet ? (
        <Dialog title="Contents" phone="sheet" width="sm" onClose={() => setSheet(false)} opener={chosen} bodyStyle={{ padding: `${theme.space(2)}px ${theme.space(4)}px ${theme.space(4)}px` }}>
          <GuideOutlineNav
            outline={OUTLINE}
            current={current}
            all
            onPick={(id) => {
              // The page goes to the chosen heading behind the sheet, the address keeps it for Back, and focus lands on it as the sheet closes.
              const heading = document.getElementById(id);
              if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
              heading?.scrollIntoView();
              chosen.current = heading;
              setSheet(false);
            }}
          />
        </Dialog>
      ) : null}
    </main>
  );
}

/** The heading id a hash names, or null for none or one that cannot be read. */
function sectionOf(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}
