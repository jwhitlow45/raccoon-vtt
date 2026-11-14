import { Button } from "../../client/components/Button.tsx";
import { theme } from "../../client/lib/theme.ts";
import { BOX } from "./StatusSection.tsx";
import { WORDS, type RaccoonLocal } from "../contract.ts";

/** The version and Source code at the foot, with Quit (design 9, item 7). */
export function Footer(props: { version: string; bridge: RaccoonLocal; onQuit(): void }) {
  return (
    <footer style={{ ...BOX, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: theme.space(2) }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), color: theme.color.textMuted, fontSize: theme.font.small }}>
        <span>{WORDS.footer.version(props.version)}</span>
        <Button size="sm" onClick={() => void props.bridge.openSource()}>
          {WORDS.footer.sourceCode}
        </Button>
      </div>
      <Button onClick={props.onQuit}>{WORDS.footer.quit}</Button>
    </footer>
  );
}
