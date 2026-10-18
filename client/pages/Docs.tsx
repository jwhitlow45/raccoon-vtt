import { useEffect } from "react";
import { Button } from "../components/Button.tsx";
import { DOCS } from "../features/guide/docs.ts";
import { navigate } from "../lib/navigation.ts";
import { theme } from "../lib/theme.ts";
import { APP_TITLE } from "../lib/title.ts";
import { HomeHeader } from "./Home.tsx";

/**
 * The Docs page at /docs, for anyone, signed in or not: every written doc
 * with a line on what it covers (features/guide/docs.ts). Its look follows
 * the DM guide's page.
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
        padding: `calc(${theme.safe.top} + ${theme.space(6)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(20)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: theme.space(4) }}>
        <HomeHeader
          title="Docs"
          tagline="Everything written about RaccoonVTT."
          actions={
            <Button size="sm" onClick={() => navigate("/")}>
              Home
            </Button>
          }
        />
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
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
                  display: "grid",
                  gap: theme.space(0.5),
                  minHeight: theme.touch,
                  padding: `${theme.space(3)}px ${theme.space(4)}px`,
                  borderRadius: theme.radius.lg,
                  border: `${theme.line.border}px solid ${theme.color.border}`,
                  background: theme.color.surface,
                  color: theme.color.text,
                  textDecoration: "none",
                }}
              >
                <span style={{ fontSize: theme.font.heading, fontWeight: theme.weight.bold, color: theme.color.accent }}>{doc.title}</span>
                <span style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{doc.description}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
