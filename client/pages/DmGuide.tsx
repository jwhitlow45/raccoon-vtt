import { useEffect, useLayoutEffect } from "react";
import GUIDE from "../../docs/dm-guide.md?raw";
import { Button } from "../components/Button.tsx";
import { Markdown, type MarkdownImage } from "../components/Markdown.tsx";
import { DOCS_PATH } from "../features/guide/docs.ts";
import { guideBody, guideImageName, guideImageSize } from "../features/guide/guide.ts";
import { navigate } from "../lib/navigation.ts";
import { theme } from "../lib/theme.ts";
import { APP_TITLE } from "../lib/title.ts";
import { HomeHeader } from "./Home.tsx";

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

const BODY = guideBody(GUIDE);

/**
 * The DM guide at /docs/dm-guide, for anyone, signed in or not. It is the
 * repository's docs/dm-guide.md, drawn by the journal's renderer with the
 * guide's additions (components/markdown.ts): its contents list links to
 * each heading, and each heading has the id GitHub gives it, so
 * /docs/dm-guide#areas opens on Areas here and on GitHub alike.
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

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        padding: `calc(${theme.safe.top} + ${theme.space(6)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(20)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: theme.space(4) }}>
        <HomeHeader
          title="DM guide"
          tagline="Building maps and running fights, step by step."
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
        <Markdown text={BODY} guide image={image} style={{ fontSize: theme.font.input, lineHeight: 1.55 }} />
      </div>
      {/* The contents list is the way around a long page, so it stays one tap away from anywhere in it. */}
      <a
        href="#contents"
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
          fontSize: theme.font.body14,
          fontWeight: theme.weight.strong,
          textDecoration: "none",
        }}
      >
        Contents
      </a>
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
