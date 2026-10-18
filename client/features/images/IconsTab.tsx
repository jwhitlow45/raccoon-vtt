import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IconImage } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { PINNED_FOOT } from "../../components/Dialog.tsx";
import { Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { Swatches } from "../../components/Swatches.tsx";
import { MEMBER_COLOR_NAMES, theme } from "../../lib/theme.ts";
import { screenHeight } from "../device/layout.ts";
import { gridWindow, tilePosition } from "./grid.ts";
import { Glyph, IconDisk } from "./IconDisk.tsx";
import { DEFAULT_ICON_COLOR, ICON_COLORS, iconCredit, iconUrl, searchIcons, useIconGlyph, useIconIndex, type IconEntry } from "./icons.ts";

/**
 * The image picker's Icons tab (docs/design-v1-dm-tools.md 3.12): search
 * the game-icons.net set by the words of a name and its author, pick one
 * from a windowed grid, pick the disk's color, and Use. It needs no upload,
 * no search quota and no outside service, so it works when the server's
 * image search is spent and, once the index has loaded, offline.
 */

const TILE = 56;
const GAP = 4;
/** The member colors by the names every swatch row uses, then the neutrals only the icon disk offers. */
const COLOR_NAMES: Record<string, string> = {
  ...MEMBER_COLOR_NAMES,
  "#8b8a93": "Gray",
  "#55545c": "Slate",
  "#2a2a32": "Charcoal",
  "#0b0b0e": "Black",
};

export function IconsTab(props: { disabled: boolean; initial?: IconImage; onUse(image: IconImage): void }) {
  const index = useIconIndex();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(props.initial?.icon ?? null);
  const [color, setColor] = useState(props.initial?.color ?? DEFAULT_ICON_COLOR);
  // Typing stays quick while the grid catches up on a slow phone.
  const deferred = useDeferredValue(query);
  const catalog = index.status === "ready" ? index.catalog : null;
  const results = useMemo(() => (catalog ? searchIcons(catalog, deferred) : []), [catalog, deferred]);
  const credit = selected ? iconCredit(selected) : null;

  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <Input aria-label="Search icons" type="search" enterKeyHint="search" placeholder="goblin, dragon head, skull lorc" maxLength={80} value={query} onChange={(e) => setQuery(e.target.value)} />
      {index.status === "loading" ? <Loading text="Loading the icons…" /> : null}
      {index.status === "failed" ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: theme.space(2), color: theme.color.textMuted }}>
          <span style={{ flex: 1 }}>The icon list did not load. Check the connection and try again.</span>
          <Button icon="retry" size="sm" onClick={index.retry}>
            Try again
          </Button>
        </div>
      ) : null}
      {catalog ? (
        <>
          <p aria-live="polite" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body }}>
            {results.length === 0
              ? "No icon matches. Try fewer or shorter words."
              : deferred.trim()
                ? `${results.length.toLocaleString("en-US")} ${results.length === 1 ? "icon matches" : "icons match"}.`
                : `${results.length.toLocaleString("en-US")} icons from game-icons.net.`}
          </p>
          <IconGrid entries={results} selected={selected} disabled={props.disabled} onSelect={setSelected} />
        </>
      ) : null}
      {/* The swatches wrap, so at 130% on the narrowest phone the row breaks in two rather than pushing the picker's Use off the screen. */}
      <Swatches label="Disk color" value={color} options={ICON_COLORS.map((c) => ({ color: c, name: COLOR_NAMES[c] ?? c }))} onChange={setColor} />
      {/* Pinned to the dialog's foot, as the Starter tab's chosen work is, so Use never waits under the fold. */}
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(3), minHeight: 72, ...PINNED_FOOT }}>
        {selected ? (
          <IconDisk icon={selected} color={color} width={72} shape="circle" ring={theme.color.border} fallback={<span style={{ fontWeight: theme.weight.bold }}>{credit?.title.slice(0, 2) ?? ""}</span>} />
        ) : (
          <span aria-hidden style={{ flex: "none", width: 72, height: 72, borderRadius: theme.radius.round, border: `${theme.line.strong}px dashed ${theme.color.border}` }} />
        )}
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
          {credit ? (
            <>
              <strong style={{ overflowWrap: "anywhere" }}>{credit.title}</strong>
              <span style={{ color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body }}>
                {credit.title} by {credit.author},{" "}
                {credit.licenseUrl ? (
                  <a href={credit.licenseUrl} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent }}>
                    {credit.license}
                  </a>
                ) : (
                  credit.license
                )}
              </span>
            </>
          ) : (
            <Help>Pick an icon, then a color for its disk.</Help>
          )}
        </div>
        <Button variant="primary" disabled={!selected || props.disabled} onClick={() => selected && props.onUse({ icon: selected, color })} style={{ flex: "none" }}>
          Use
        </Button>
      </div>
    </div>
  );
}

/** The results, windowed: only the tiles in view and a couple of rows around them are mounted, and only those fetch their art. */
function IconGrid(props: { entries: readonly IconEntry[]; selected: string | null; disabled: boolean; onSelect(key: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ width: 0, height: 0, scrollTop: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new search starts at the top.
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
    setView((v) => ({ ...v, scrollTop: 0 }));
  }, [props.entries]);

  const w = gridWindow({ count: props.entries.length, width: view.width, viewHeight: view.height, scrollTop: view.scrollTop, tile: TILE, gap: GAP });
  const tiles: ReactNode[] = [];
  for (let i = w.start; i < w.end; i++) {
    const entry = props.entries[i];
    if (!entry) continue;
    const at = tilePosition(i, w.columns, TILE, GAP);
    tiles.push(
      <IconTile key={entry.key} entry={entry} left={at.left} top={at.top} selected={entry.key === props.selected} disabled={props.disabled} onSelect={props.onSelect} />,
    );
  }
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setView((v) => (v.scrollTop === top ? v : { ...v, scrollTop: top }));
      }}
      style={{
        position: "relative",
        height: `clamp(180px, ${screenHeight(38)}, 360px)`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.bg,
        padding: GAP,
      }}
    >
      <div role="list" aria-label="Icons" style={{ position: "relative", height: w.height }}>
        {tiles}
      </div>
    </div>
  );
}

function IconTile(props: { entry: IconEntry; left: number; top: number; selected: boolean; disabled: boolean; onSelect(key: string): void }) {
  const { entry } = props;
  const glyph = useIconGlyph(entry.key);
  const url = iconUrl(entry.key);
  const credit = iconCredit(entry.key);
  const label = credit ? `${credit.title} by ${credit.author}` : entry.title;
  return (
    <div role="listitem" style={{ position: "absolute", left: props.left, top: props.top, width: TILE, height: TILE }}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={props.selected}
        title={label}
        disabled={props.disabled}
        onClick={() => props.onSelect(entry.key)}
        style={{
          width: TILE,
          height: TILE,
          padding: theme.space(0.5),
          display: "grid",
          placeItems: "center",
          borderRadius: theme.radius.sm,
          border: `${theme.line.strong}px solid ${props.selected ? theme.color.accent : "transparent"}`,
          background: props.selected ? theme.color.accentTint : theme.color.surfaceRaised,
          color: theme.color.text,
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {glyph.status === "ready" && url ? (
          <Glyph url={url} side={36} color={theme.color.text} />
        ) : glyph.status === "loading" ? null : (
          // Offline and never fetched, or a file the server lacks: the name says what it is.
          <span style={{ fontSize: theme.font.tiny, lineHeight: theme.leading.tight, textAlign: "center", overflowWrap: "anywhere", color: theme.color.textMuted }}>{entry.title}</span>
        )}
      </button>
    </div>
  );
}
