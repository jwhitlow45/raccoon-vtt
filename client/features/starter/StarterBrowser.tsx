import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { packsFor, type FoundWork, type StarterPack, type StarterUse, type StarterWork } from "#shared/starter.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { browserProbe, LoadFailureNotice } from "../../components/LoadBoundary.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { classifyLoadFailure, type LoadFailure } from "../../lib/chunkLoad.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { screenHeight } from "../device/layout.ts";
import { tileImage, tileStyle } from "../images/LibraryGrid.tsx";
import { byCategory, findShown, packLine, resultLine, searchGroups, tileSource, workCredit } from "./browse.ts";
import { loadedStarterPacks, loadStarterPacks, onStarterPacks } from "./catalog.ts";

/**
 * The Starter tab (docs/design-v1-starter-art.md 4): the packs that fit
 * the place it opens in, each folded under its name, its works by
 * category inside, a search over names, categories and tags across those
 * packs, and under the tiles the chosen work's name, pack, author and
 * license with Use. One component for the four places that pick art, each
 * passing the uses it shows and what Use does there.
 *
 * A pack's fold has the panel Group's look and heading level (h3, its
 * categories h4) rather than the Group itself, whose name keeps to one
 * line: a pack's name runs long, and on a phone it must wrap.
 *
 * One pack opens at a time and a search shows at most SEARCH_SHOWN tiles,
 * so a phone never mounts a whole catalog's previews at once. The tiles
 * scroll in a box of their own, as the Icons tab's do, so Use stays in
 * view under them.
 */

const PLACEHOLDER: Record<StarterUse, string> = {
  token: "owlbear, elf, knight",
  map: "cave, tavern, crypt",
  handout: "portrait, dragon, letter",
  stamp: "bench, candle, crate",
};

type CatalogState = { packs: readonly StarterPack[] | null; failure: LoadFailure | "checking" | null };

/**
 * The catalog for a picker: at once when the background load finished,
 * else loading. A module that failed to load stays failed for the page in
 * Chrome, so a failure is answered as a panel's is: told apart as offline,
 * updated or failed (lib/chunkLoad.ts), with the reload that waits for the
 * queued edits. Read as an external store, so a load another picker
 * finished reaches this one too.
 */
function useStarterPacks(): CatalogState {
  const packs = useSyncExternalStore(onStarterPacks, loadedStarterPacks, loadedStarterPacks);
  const [failure, setFailure] = useState<CatalogState["failure"]>(null);
  useEffect(() => {
    if (packs) return;
    let live = true;
    loadStarterPacks().catch((err: unknown) => {
      if (!live) return;
      setFailure("checking");
      classifyLoadFailure(err, browserProbe()).then(
        (why) => live && setFailure(why),
        () => live && setFailure("failed"),
      );
    });
    return () => {
      live = false;
    };
  }, [packs]);
  return { packs, failure: packs ? null : failure };
}

export function StarterBrowser(props: {
  uses: readonly StarterUse[];
  onUse(found: FoundWork): void;
  /** Use's copy is under way: Use shows it and takes no second tap. */
  busy?: boolean;
  /** Use's label while busy. */
  busyLabel?: string;
  /** Every pick is off, as while the picker runs another step. */
  disabled?: boolean;
  /** A line before the packs, on what a pick does here. */
  hint?: ReactNode;
  /** The floor behind a tile, for art with transparent edges made to lie on a map (stamps). */
  floor?: string;
  /** More under the chosen work's credit, such as a map's feet per square. */
  note?(found: FoundWork): ReactNode;
}) {
  const catalog = useStarterPacks();
  const pending = useRoomView((s) => s.pending.length);
  const connection = useRoomView((s) => s.connection);
  const usesKey = props.uses.join(",");
  // The key stands for the uses, so a new array of the same uses filters nothing again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const packs = useMemo(() => (catalog.packs ? packsFor(catalog.packs, props.uses) : null), [catalog.packs, usesKey]);
  const [query, setQuery] = useState("");
  // Typing stays quick while the tiles catch up on a slow phone.
  const deferred = useDeferredValue(query);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const search = useMemo(() => (packs && deferred.trim() ? searchGroups(packs, deferred) : null), [packs, deferred]);
  const chosen = packs ? findShown(packs, selected) : null;
  // A place with one pack opens on it.
  const openPack = packs?.length === 1 ? (packs[0]?.id ?? null) : open;
  const disabled = props.disabled === true;

  const tiles = (works: readonly StarterWork[], label: string) => (
    <ul aria-label={label} style={TILES}>
      {works.map((work) => (
        <li key={work.key} style={{ display: "grid", gap: theme.space(0.5), alignContent: "start", minWidth: 0 }}>
          <WorkTile work={work} selected={work.key === selected} disabled={disabled} floor={props.floor} onSelect={setSelected} />
        </li>
      ))}
    </ul>
  );

  if (catalog.failure) {
    return (
      <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
        {props.hint ? <Help>{props.hint}</Help> : null}
        <LoadFailureNotice failure={catalog.failure} retry={() => undefined} subject="The starter packs" verb="load" pending={pending} connection={connection} />
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      {props.hint ? <Help>{props.hint}</Help> : null}
      <Input
        aria-label="Search the starter packs"
        type="search"
        enterKeyHint="search"
        placeholder={PLACEHOLDER[props.uses[0] ?? "token"]}
        maxLength={80}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!packs ? <Loading text="Loading the starter packs…" /> : null}
      {packs ? (
        <>
          <p aria-live="polite" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body }}>
            {resultLine({ packs, query: deferred, search })}
          </p>
          {packs.length === 0 ? (
            <Empty>No starter art fits here yet.</Empty>
          ) : (
            <div
              role="region"
              aria-label="Starter packs"
              style={{
                height: `clamp(200px, ${screenHeight(44)}, 440px)`,
                overflowY: "auto",
                overscrollBehavior: "contain",
                borderRadius: theme.radius.md,
                border: `${theme.line.border}px solid ${theme.color.border}`,
                background: theme.color.bg,
                padding: `0 ${theme.space(2)}px`,
              }}
            >
              {search
                ? search.groups.map((group) => (
                    <section key={group.pack.id} style={{ display: "grid", gap: theme.space(2), padding: `${theme.space(2)}px 0` }}>
                      <SectionLabel level={3}>{group.pack.title}</SectionLabel>
                      {tiles(group.works, group.pack.title)}
                    </section>
                  ))
                : packs.map((pack, i) => (
                    <PackFold
                      key={pack.id}
                      pack={pack}
                      open={openPack === pack.id}
                      single={packs.length === 1}
                      first={i === 0}
                      onToggle={() => setOpen(openPack === pack.id ? null : pack.id)}
                    >
                      {byCategory(pack).map((category) => (
                        <section key={category.name} style={{ display: "grid", gap: theme.space(2) }}>
                          <SectionLabel level={4}>{category.name}</SectionLabel>
                          {tiles(category.works, `${pack.title}: ${category.name}`)}
                        </section>
                      ))}
                    </PackFold>
                  ))}
            </div>
          )}
        </>
      ) : null}
      <Chosen
        found={chosen}
        floor={props.floor}
        note={chosen && props.note ? props.note(chosen) : null}
        busy={props.busy === true}
        busyLabel={props.busyLabel ?? "Adding…"}
        disabled={disabled}
        onUse={props.onUse}
      />
    </div>
  );
}

const TILES = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
  gap: theme.space(2),
} as const;

/**
 * A pack under its name, folded until opened: a 48 px disclosure with the
 * author, license and count on a line of their own, which wraps, since a
 * pack's name can run long ("Warlock's Gauntlet: ruins, wrecks, bones and
 * woods"). A place with one pack shows it open, with no disclosure.
 */
function PackFold(props: { pack: StarterPack; open: boolean; single: boolean; first: boolean; onToggle(): void; children: ReactNode }) {
  const id = useId();
  const header = useRef<HTMLHeadingElement>(null);
  const opened = useRef(false);
  /*
   * Opening a pack folds the one open above it, which can pull the tapped
   * name out of the box's view. So a pack the DM opens is scrolled back
   * into view, never on first draw, which would scroll a dialog that just
   * opened.
   */
  useEffect(() => {
    if (props.open && opened.current && !props.single) header.current?.scrollIntoView({ block: "nearest" });
    opened.current = true;
  }, [props.open, props.single]);
  const line = (
    <span id={`${id}-line`} style={{ display: "block", fontSize: theme.font.small, fontWeight: theme.weight.regular, color: theme.color.textMuted, lineHeight: theme.leading.body }}>
      {packLine(props.pack)}
    </span>
  );
  const name = (
    <span id={`${id}-name`} style={{ display: "block", fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{props.pack.title}</span>
  );
  return (
    <section aria-labelledby={`${id}-name`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", borderTop: props.first ? undefined : `${theme.line.border}px solid ${theme.color.border}` }}>
      <h3 ref={header} style={{ margin: 0, display: "flex" }}>
        {props.single ? (
          <span style={{ flex: 1, minWidth: 0, display: "grid", alignContent: "center", gap: theme.space(0.5), minHeight: 48, padding: `${theme.space(1)}px 0` }}>
            {name}
            {line}
          </span>
        ) : (
          <button
            type="button"
            aria-expanded={props.open}
            // Named by the pack's name alone, so the name never changes as it folds. The line describes it.
            aria-labelledby={`${id}-name`}
            aria-describedby={`${id}-line`}
            onClick={props.onToggle}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: theme.space(2),
              minHeight: 48,
              padding: `${theme.space(1)}px 0`,
              background: "transparent",
              border: "none",
              color: theme.color.text,
              fontFamily: theme.font.body,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span style={{ color: theme.color.textMuted, display: "flex", flex: "none" }}>
              <Icon name={props.open ? "chevronDown" : "chevronRight"} size="sm" />
            </span>
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
              {name}
              {line}
            </span>
          </button>
        )}
      </h3>
      {props.open ? <div style={{ display: "grid", gap: theme.space(3), paddingBottom: theme.space(3) }}>{props.children}</div> : null}
    </section>
  );
}

/** One work: its preview in the library's tile, its name under it, the chosen look once tapped. */
function WorkTile(props: { work: StarterWork; selected: boolean; disabled: boolean; floor?: string; onSelect(key: string): void }) {
  const { work } = props;
  return (
    <>
      <button
        type="button"
        aria-label={work.name}
        aria-pressed={props.selected}
        title={work.name}
        disabled={props.disabled}
        onClick={() => props.onSelect(work.key)}
        style={{
          ...tileStyle,
          position: "relative",
          background: props.floor ?? tileStyle.background,
          border: props.selected ? `${theme.line.strong}px solid ${theme.color.accent}` : tileStyle.border,
          cursor: props.disabled ? "default" : "pointer",
        }}
      >
        <Preview key={tileSource(work)} src={tileSource(work)} />
      </button>
      <span aria-hidden style={{ fontSize: theme.font.tiny, color: props.selected ? theme.color.accent : theme.color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {work.name}
      </span>
    </>
  );
}

/**
 * A work's preview: the one loading line until it arrives (after the
 * shared delay, so a cached one never flashes it), and a plain tile that
 * says so when it will not load, never a broken image. The tile can still
 * be picked, since the server copies the work from its own files.
 */
function Preview(props: { src: string; side?: number }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const img = useRef<HTMLImageElement>(null);
  /*
   * An image the browser already holds may be complete by the first effect.
   * Only a decoded one counts: a lazy image not yet started can read as
   * complete with no size in some engines, and its error, if any, still
   * comes as an event.
   */
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setState("ready");
  }, []);
  if (state === "failed") {
    return (
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: "100%",
          height: "100%",
          padding: theme.space(1),
          boxSizing: "border-box",
          background: theme.color.surfaceRaised,
          color: theme.color.textMuted,
          fontSize: theme.font.tiny,
          lineHeight: theme.leading.tight,
          textAlign: "center",
        }}
      >
        This preview did not load
      </span>
    );
  }
  return (
    <>
      <img ref={img} src={props.src} alt="" loading="lazy" decoding="async" onLoad={() => setState("ready")} onError={() => setState("failed")} style={{ ...tileImage, objectFit: "contain" }} />
      {state === "loading" ? (
        <Loading
          text="Loading…"
          live={false}
          style={{ position: "absolute", inset: 0, flexDirection: "column", justifyContent: "center", gap: theme.space(1), fontSize: theme.font.tiny, textAlign: "center" }}
        />
      ) : null}
    </>
  );
}

const CHOSEN_SIDE = 72;

/** The chosen work under the tiles, as the Icons tab shows its icon: the preview, the credit, and Use. */
function Chosen(props: { found: FoundWork | null; floor?: string; note: ReactNode; busy: boolean; busyLabel: string; disabled: boolean; onUse(found: FoundWork): void }) {
  const { found } = props;
  const credit = found ? workCredit(found) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(3), minHeight: CHOSEN_SIDE }}>
      {found ? (
        <span
          style={{
            position: "relative",
            flex: "none",
            width: CHOSEN_SIDE,
            height: CHOSEN_SIDE,
            overflow: "hidden",
            borderRadius: theme.radius.sm,
            border: `${theme.line.border}px solid ${theme.color.border}`,
            background: props.floor ?? theme.color.bg,
          }}
        >
          <Preview key={tileSource(found.work)} src={tileSource(found.work)} />
        </span>
      ) : (
        <span aria-hidden style={{ flex: "none", width: CHOSEN_SIDE, height: CHOSEN_SIDE, borderRadius: theme.radius.sm, border: `${theme.line.strong}px dashed ${theme.color.border}`, boxSizing: "border-box" }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
        {credit ? (
          <>
            <strong style={{ overflowWrap: "anywhere" }}>{credit.name}</strong>
            <span style={{ color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
              {credit.pack}, by {credit.author},{" "}
              {credit.licenseUrl ? (
                <a href={credit.licenseUrl} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent }}>
                  {credit.license}
                </a>
              ) : (
                credit.license
              )}
            </span>
            {props.note}
          </>
        ) : (
          <Help>Pick a picture to see who made it.</Help>
        )}
      </div>
      <Button
        variant="primary"
        busy={props.busy}
        disabled={!found || (props.disabled && !props.busy)}
        onClick={() => found && props.onUse(found)}
        style={{ flex: "none" }}
      >
        {props.busy ? props.busyLabel : "Use"}
      </Button>
    </div>
  );
}
