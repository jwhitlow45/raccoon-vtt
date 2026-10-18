import { useEffect } from "react";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { DOCS } from "../features/guide/docs.ts";
import { DocsTopBar, DocTitle } from "../features/guide/DocsHeader.tsx";
import { navigate } from "../lib/navigation.ts";
import { theme } from "../lib/theme.ts";
import { APP_TITLE } from "../lib/title.ts";

/**
 * The Docs page at /docs, for anyone, signed in or not: every written doc
 * with a line on what it covers (features/guide/docs.ts). It wears the DM
 * guide's top bar and title block, so the two read as one set of docs.
 */
export default function Docs() {
  useEffect(() => {
    document.title = `${APP_TITLE} · Docs`;
    return () => {
      document.title = APP_TITLE;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        padding: `calc(${theme.safe.top} + ${theme.space(4)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(20)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <DocsTopBar
          actions={
            <Button size="sm" onClick={() => navigate("/")}>
              Home
            </Button>
          }
        />
        <DocTitle label="RaccoonVTT documentation" title="Docs" subtitle="Everything written about RaccoonVTT." />
        <ul style={{ listStyle: "none", margin: `${theme.space(8)}px 0 0`, padding: 0, display: "grid", gap: theme.space(3) }}>
          {DOCS.map((doc) => (
            <li key={doc.path}>
              <a
                href={doc.path}
                onClick={(e) => {
                  // A plain click stays in the app. Modified clicks keep the browser's own new-tab behavior.
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  navigate(doc.path);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: theme.space(4),
                  minHeight: theme.touch,
                  padding: `${theme.space(5)}px ${theme.space(5)}px`,
                  borderRadius: theme.radius.lg,
                  border: `${theme.line.border}px solid ${theme.color.border}`,
                  borderTop: `${theme.line.stripe}px solid ${theme.color.accent}`,
                  background: theme.color.surface,
                  color: theme.color.text,
                  textDecoration: "none",
                }}
              >
                <span style={{ flex: "1 1 auto", display: "grid", gap: theme.space(1) }}>
                  <span style={{ fontSize: theme.font.title, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>{doc.title}</span>
                  <span style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{doc.description}</span>
                </span>
                <Icon name="chevronRight" style={{ color: theme.color.textMuted }} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
