import { useCallback, useEffect, useRef, useState } from "react";
import type { IconImage, ImageRef } from "#shared/model.ts";
import type { FoundWork } from "#shared/starter.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Empty } from "../../components/Empty.tsx";
import { ErrorText, Input } from "../../components/Field.tsx";
import { choiceLook } from "../../components/looks.ts";
import { Notice } from "../../components/Notice.tsx";
import { Help } from "../../components/Panel.tsx";
import { api, type AssetRow, type SearchResult, type SearchSource } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { licenseName } from "./credit.ts";
import { imageErrorMessage, isQuotaError, isShortWait } from "./errors.ts";
import { LibraryGrid, tileImage, tileStyle } from "./LibraryGrid.tsx";
import { IconsTab } from "./IconsTab.tsx";
import { rememberAsset } from "./library.ts";
import { honorsImageOrientation } from "./orientation.ts";
import { isThumbnailUrl } from "#shared/searchThumbnails.ts";
import { StarterBrowser } from "../starter/StarterBrowser.tsx";
import { PickError, checkImageUrl, searchConfig, uploadTokenImage } from "./upload.ts";

/**
 * The image picker for tokens, characters and monsters (features section 6,
 * design 11.1 to 11.3): a shipped game-icons.net icon on a colored disk,
 * upload from the device (the camera roll on a phone), paste from the
 * clipboard, paste an image link, search the web, reuse an image already
 * in the room's library, or copy one in from the starter packs
 * (docs/design-v1-starter-art.md 4).
 *
 * Icons come first and always work: picking one is the caller's op alone,
 * with no upload and no quota (docs/design-v1-dm-tools.md 3.12). Every
 * other path ends in an asset row on the server, which the caller then
 * crops. Uploads, imports and searches wait out a busy server for up to
 * 60 s ("Waiting for the server…") before they give up.
 *
 * The sources stay tabs (`tablist`, `tab`, `tabpanel`), not a choice of
 * radios, since each shows a panel of its own. The chosen tab takes the
 * pressed look (docs/design-v1-visual.md 2.3).
 */

export type PickedImage = { id: string; width?: number; height?: number };

/** The starter works a token or portrait may use. */
const STARTER_USES = ["token"] as const;
/** The picker's status while a starter work is copied in, which is also how its Use knows the copy is its own. */
const STARTER_BUSY = "Adding to the room…";

type Tab = "icons" | "starter" | "device" | "link" | "search" | "library";

export function ImagePicker(props: {
  onPick(image: PickedImage): void;
  /** An icon chosen on the Icons tab, which needs no crop. */
  onPickIcon(image: IconImage): void;
  /** The image being replaced: an icon opens the Icons tab on it and its color. */
  current?: ImageRef | null;
  onClose(): void;
  /** What the image is for, a visible line above the tabs, so a phone with no hover reads it on the first tap. */
  hint?: string;
}) {
  const roomId = useRoomView((s) => s.roomId);
  const [tab, setTab] = useState<Tab>("icons");
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { onPick, onClose } = props;

  useEffect(() => {
    // Start the orientation check now, so it has finished by the first upload.
    void honorsImageOrientation();
    let live = true;
    void searchConfig().then((c) => live && setSearchEnabled(c.searchEnabled));
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, []);

  /** Runs one server step with the busy note, the 503 wait note and plain-words errors. */
  const run = useCallback(
    async <T,>(label: string, step: (signal: AbortSignal, onWaiting: (w: boolean) => void) => Promise<T>): Promise<T | null> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(label);
      setError(null);
      try {
        return await step(controller.signal, setWaiting);
      } catch (err) {
        if (controller.signal.aborted) return null;
        setError(err instanceof PickError ? err.message : imageErrorMessage(err));
        // A spent day's searches leave the icons, which need no search. A minute's wait stays put.
        if (isQuotaError(err) && !isShortWait(err)) setTab("icons");
        return null;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(null);
          setWaiting(false);
        }
      }
    },
    [],
  );

  const finish = useCallback(
    (asset: AssetRow | null) => {
      if (!asset) return;
      // An Openverse image's credit shows in the token panel at once, before the library lists it.
      rememberAsset(roomId, asset);
      onPick({ id: asset.id, width: asset.width, height: asset.height });
    },
    [onPick, roomId],
  );

  const upload = useCallback(
    async (file: Blob) => finish(await run("Uploading…", (signal, onWaiting) => uploadTokenImage(roomId, file, { signal, onWaiting }))),
    [finish, run, roomId],
  );

  const importUrl = useCallback(
    async (url: string, fallback?: string) =>
      finish(
        await run("Importing…", (signal, onWaiting) =>
          api.importAsset(roomId, { url, kind: "token", ...(fallback ? { fallback } : {}) }, { signal, onWaiting }),
        ),
      ),
    [finish, run, roomId],
  );

  // A starter work is copied in as the room's own token image, with the catalog's credit, then cropped as a library pick is.
  const pickStarter = useCallback(
    async (found: FoundWork) =>
      finish(await run(STARTER_BUSY, (signal, onWaiting) => api.pickStarter(roomId, { work: found.work.key, kind: "token" }, { signal, onWaiting }))),
    [finish, run, roomId],
  );

  // A paste anywhere while the picker is open: an image uploads, a link imports.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const file = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
      if (file) {
        e.preventDefault();
        void upload(file);
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && /^https:\/\//i.test(text)) {
        e.preventDefault();
        void importUrl(text);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [upload, importUrl]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "icons", label: "Icons" },
    { id: "starter", label: "Starter" },
    { id: "device", label: "Device" },
    { id: "link", label: "Link" },
    ...(searchEnabled ? [{ id: "search" as const, label: "Search the web" }] : []),
    { id: "library", label: "Library" },
  ];

  return (
    <Dialog
      title="Choose an image"
      onClose={onClose}
      width="lg"
      phone="fill"
      status={busy ? <span role="status">{waiting ? "Waiting for the server…" : busy}</span> : undefined}
      footer={busy ? <Button onClick={() => abortRef.current?.abort()}>Cancel</Button> : undefined}
    >
      {props.hint ? <p style={{ margin: `0 0 ${theme.space(3)}px`, fontSize: theme.font.body14, color: theme.color.textMuted }}>{props.hint}</p> : null}
      <div role="tablist" aria-label="Where the image comes from" style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), marginBottom: theme.space(3) }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setError(null);
            }}
            style={{
              flex: "1 0 auto",
              minHeight: theme.touch,
              padding: `0 ${theme.space(3)}px`,
              borderRadius: theme.radius.md,
              fontFamily: theme.font.body,
              fontSize: theme.font.body14,
              fontWeight: theme.weight.strong,
              cursor: "pointer",
              ...choiceLook(tab === t.id),
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error ? (
        <div style={{ marginBottom: theme.space(3) }}>
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}
      <div role="tabpanel">
        {tab === "icons" ? (
          <IconsTab disabled={busy !== null} initial={props.current && "icon" in props.current ? props.current : undefined} onUse={props.onPickIcon} />
        ) : null}
        {tab === "starter" ? (
          <StarterBrowser
            uses={STARTER_USES}
            hint="Openly licensed art packs. Use copies the picture into this room's library with its credit."
            busy={busy === STARTER_BUSY}
            busyLabel="Adding…"
            disabled={busy !== null}
            onUse={(found) => void pickStarter(found)}
          />
        ) : null}
        {tab === "device" ? <DeviceTab disabled={busy !== null} onFile={upload} onUrl={importUrl} onError={setError} /> : null}
        {tab === "link" ? <LinkTab disabled={busy !== null} onUrl={importUrl} /> : null}
        {tab === "search" ? (
          <SearchTab
            disabled={busy !== null}
            search={(q, source) =>
              run(source === "openverse" ? "Searching Openverse…" : "Searching…", (signal, onWaiting) =>
                api.imageSearch(roomId, q, { signal, onWaiting, ...(source ? { source } : {}) }),
              )
            }
            onPick={(r) => importUrl(r.original, r.thumbnail)}
          />
        ) : null}
        {tab === "library" ? <LibraryGrid roomId={roomId} disabled={busy !== null} onPick={(id) => onPick({ id })} /> : null}
      </div>
    </Dialog>
  );
}

/*
 * A field beside its button in one row. `width: 0` with `flex: 1` keeps the
 * field's own size, which a browser gives a text input, out of the row's
 * smallest width: without it the row would not shrink below that size plus
 * the button, and at 130% on a phone it pushed the tab 5 px wider than the
 * dialog, so the body scrolled sideways.
 */
const rowField = { flex: 1, width: 0 } as const;

function DeviceTab(props: { disabled: boolean; onFile(file: Blob): void; onUrl(url: string): void; onError(message: string): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const canReadClipboard = typeof navigator !== "undefined" && !!navigator.clipboard && "read" in navigator.clipboard;

  /** The Paste button, for phones, where there is no keyboard shortcut to paste with. */
  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/") && !t.startsWith("image/svg"));
        if (type) {
          props.onFile(await item.getType(type));
          return;
        }
      }
      const text = (await navigator.clipboard.readText()).trim();
      if (/^https:\/\//i.test(text)) {
        props.onUrl(text);
        return;
      }
      props.onError("The clipboard has no image or image link in it.");
    } catch {
      props.onError("The browser did not allow reading the clipboard. Try pasting with the keyboard instead.");
    }
  };

  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) props.onFile(file);
        }}
      />
      <Button variant="primary" disabled={props.disabled} onClick={() => inputRef.current?.click()}>
        Choose a photo or file
      </Button>
      {canReadClipboard ? (
        <Button disabled={props.disabled} onClick={() => void pasteFromClipboard()}>
          Paste from the clipboard
        </Button>
      ) : null}
      <Help>You can also paste an image or an image link anywhere in this window. Large photos are made smaller before they upload.</Help>
    </div>
  );
}

function LinkTab(props: { disabled: boolean; onUrl(url: string): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        try {
          props.onUrl(checkImageUrl(text));
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "That link does not work.");
        }
      }}
      style={{ display: "grid", gap: theme.space(2) }}
    >
      <label htmlFor="image-link" style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
        Image link
      </label>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Input
          id="image-link"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://…/goblin.png"
          value={text}
          error={error !== null}
          onChange={(e) => setText(e.target.value)}
          style={rowField}
        />
        <Button type="submit" variant="primary" disabled={props.disabled || !text.trim()}>
          Import
        </Button>
      </div>
      {error ? <p style={{ margin: 0, color: theme.color.dangerText, fontSize: theme.font.small }}>{error}</p> : null}
      <Help>The server fetches the image, checks it, and keeps its own copy.</Help>
    </form>
  );
}

/**
 * Web image search (design 11.3, docs/design-v1-dm-tools.md 3.13). The
 * server tries Google Images through SerpApi and turns to Openverse when
 * SerpApi cannot answer, and the answer names which one did, so the tab
 * says where its results came from. Under Google's results the DM can ask
 * Openverse on purpose, for openly licensed art.
 */
function SearchTab(props: {
  disabled: boolean;
  search(q: string, source?: "openverse"): Promise<{ results: SearchResult[]; source: SearchSource } | null>;
  onPick(result: SearchResult): void;
}) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<{ q: string; source: SearchSource; results: SearchResult[] } | null>(null);
  const search = async (query: string, source?: "openverse") => {
    const found = await props.search(query, source);
    if (found) setAnswer({ q: query, source: found.source, results: found.results.filter((r) => isThumbnailUrl(r.thumbnail)) });
  };
  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const query = q.trim();
          if (query) void search(query);
        }}
        style={{ display: "flex", gap: theme.space(2) }}
      >
        <Input
          aria-label="Search for"
          type="search"
          enterKeyHint="search"
          placeholder="goblin archer"
          maxLength={200}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={rowField}
        />
        <Button type="submit" variant="primary" disabled={props.disabled || !q.trim()}>
          Search
        </Button>
      </form>
      {answer?.source === "openverse" ? (
        <div role="note">
          <Notice>From Openverse: openly licensed photos and artwork. RaccoonVTT is not endorsed by Openverse.</Notice>
        </div>
      ) : null}
      {answer && answer.results.length === 0 ? <Empty>No images found. Try other words.</Empty> : null}
      {answer && answer.results.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: theme.space(2) }}>
          {answer.results.map((r, i) => (
            <SearchTile key={`${r.thumbnail}|${i}`} result={r} source={answer.source} disabled={props.disabled} onPick={props.onPick} />
          ))}
        </ul>
      ) : null}
      {answer?.source === "openverse" ? (
        <Help>
          Each tile names its license. A picked image keeps its credit, shown with it in the library and the token panel. Openverse does not check licenses, so look at
          the image's page when it matters.
        </Help>
      ) : answer?.source === "google" ? (
        <div style={{ display: "grid", gap: theme.space(2), justifyItems: "start" }}>
          <Help>Google Images through SerpApi, with safe search on. Searches are limited, so repeated searches come from a cache.</Help>
          <Button disabled={props.disabled} onClick={() => void search(answer.q, "openverse")}>
            Search Openverse instead
          </Button>
        </div>
      ) : (
        <Help>Searches Google Images when the server can, and Openverse's openly licensed images when it cannot.</Help>
      )}
    </div>
  );
}

/**
 * One result. An Openverse tile names its license. A thumbnail that will
 * not load becomes a plain tile that says so, never a broken image, and can
 * still be picked, since the original may load where the preview did not.
 */
function SearchTile(props: { result: SearchResult; source: SearchSource; disabled: boolean; onPick(result: SearchResult): void }) {
  const { result } = props;
  const [failed, setFailed] = useState(false);
  const license = result.credit ? licenseName(result.credit.license, result.credit.licenseVersion) : null;
  const label = license ? `${result.title || "Untitled"}, ${license}` : `${result.title} (${result.source})`;
  return (
    <li style={{ display: "grid", gap: theme.space(0.5), alignContent: "start" }}>
      <button type="button" disabled={props.disabled} onClick={() => props.onPick(result)} title={label} aria-label={label} style={tileStyle}>
        {failed ? (
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
            {props.source === "openverse" ? "Openverse could not show this preview" : "This preview did not load"}
          </span>
        ) : (
          <img src={result.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} style={tileImage} />
        )}
      </button>
      {license ? (
        <span aria-hidden style={{ fontSize: theme.font.tiny, color: theme.color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {license}
        </span>
      ) : null}
    </li>
  );
}
