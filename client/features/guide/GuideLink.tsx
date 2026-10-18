import type { CSSProperties, ReactNode } from "react";
import { theme } from "../../lib/theme.ts";
import { guideHref } from "./guide.ts";

/**
 * A link to the DM guide, or to one of its sections. It opens in a new
 * tab, so the room stays connected and where it was. `name` is the link's
 * full name for a screen reader, which must hold its visible text.
 */
export function GuideLink(props: { section?: string; name: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <a
      href={guideHref(props.section)}
      target="_blank"
      rel="noopener"
      aria-label={`${props.name} (opens in a new tab)`}
      style={{ color: theme.color.accent, fontSize: theme.font.small, textDecoration: "underline", ...props.style }}
    >
      {props.children}
    </a>
  );
}

/** For the DM's empty states, where a DM new to the app first looks: the way into the guide's quick start. */
export function QuickStartLink() {
  const text = "New here? Start with the DM guide's quick start.";
  return (
    <GuideLink section="quick-start" name={text} style={{ fontSize: theme.font.body14 }}>
      {text}
    </GuideLink>
  );
}

/**
 * The foot of a panel the guide covers, for the DM: a small "Guide" link to
 * the panel's section, out of the way of the header and of the panel's own
 * controls.
 */
export function PanelGuideLink(props: { section: string; panel: string }) {
  return (
    <p style={{ margin: `${theme.space(4)}px 0 0`, lineHeight: theme.leading.body }}>
      <GuideLink section={props.section} name={`${props.panel} in the DM guide`}>
        Guide
      </GuideLink>
    </p>
  );
}
