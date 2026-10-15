import type { ReactNode } from "react";
import { theme } from "../../lib/theme.ts";
import { listText, tokenIconsSection } from "./credits.ts";

/**
 * The About page's "Token icons" group: the mention game-icons.net asks for,
 * each license with its link and how many icons it covers, what was
 * changed, and every author with their count.
 */
export function TokenIconsCredit() {
  const section = tokenIconsSection();
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <h4 style={{ margin: 0, fontSize: theme.font.input, fontWeight: theme.weight.bold }}>{section.heading}</h4>
      <p style={{ margin: 0 }}>
        {section.madeBy} Available on <Link href={section.site}>{section.site}</Link>.
      </p>
      <ul style={{ margin: 0, paddingLeft: theme.space(5), display: "grid", gap: theme.space(1) }}>
        {section.licenses.map((license) => (
          <li key={license.id}>
            {license.url ? <Link href={license.url}>{license.name}</Link> : license.name}: {license.icons.toLocaleString("en-US")} icons
            {section.licenses.length > 1 && license.authors.length <= 3 ? ` by ${listText(license.authors)}` : ""}.
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, color: theme.color.textMuted }}>Changes: {section.changes}</p>
      <p style={{ margin: 0 }}>
        {section.authors.map((author, i) => (
          <span key={author.id}>
            {author.url ? <Link href={author.url}>{author.name}</Link> : author.name} ({author.icons.toLocaleString("en-US")})
            {i < section.authors.length - 1 ? ", " : "."}
          </span>
        ))}
      </p>
    </div>
  );
}

function Link(props: { href: string; children: ReactNode }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent, overflowWrap: "anywhere" }}>
      {props.children}
    </a>
  );
}
