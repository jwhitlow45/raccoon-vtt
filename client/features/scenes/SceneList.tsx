import { useMemo, useState, type ReactNode } from "react";
import type { Scene } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { useSceneLoading } from "../../canvas/SceneLoading.tsx";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Loading, useDelayed } from "../../components/Loading.tsx";
import { Section } from "../../components/Panel.tsx";
import { Tag } from "../../components/Tag.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomActions, useRoomView } from "../../state/view.ts";
import { browserStorage, cleanFolderName, groupScenes, moveFolder, moveScene, readCollapsed, renameMergesInto, sendFolderRename, writeCollapsed, type SceneGroup } from "./folders.ts";
import { SceneMenuButton } from "./SceneMenu.tsx";
import { thumbSources } from "./thumbnail.ts";
import { sightOf } from "#shared/keys.ts";
import { moveWarning } from "../vision/moveWarning.ts";

/**
 * The room's scenes in order. Tapping one shows it to the DM (players stay
 * where they are). "Move players" sends the party there, with a one-line
 * warning first when that scene's fog is off (design 13.2) or the party
 * may see nothing there (vision/moveWarning.ts).
 *
 * Scenes in no folder come first, then each folder under a header that
 * folds with a tap and stays folded on this device (folders.ts). Reorder
 * moves a scene within its folder, and a folder past the folder next to it.
 * Each row shows the scene's thumbnail (thumbs.ts), the name and the detail
 * on one line each, and under them "Move players" or the "Players here"
 * tag, so a long name never wraps to four lines beside the buttons.
 *
 * A scene that is loading says so on its row as well as over the map,
 * because on a phone this list is a sheet that covers the map's middle.
 * The move waits for the server, which has every player's view to build,
 * so its row says "Moving players…" until the server confirms it.
 */
export function SceneList(props: { scenes: Scene[]; viewingId: string | null; playerSceneId: string | null }) {
  const { scenes, viewingId, playerSceneId } = props;
  const actions = useRoomActions();
  const roomId = useRoomView((s) => s.roomId);
  const [arranging, setArranging] = useState(false);
  const [confirmMove, setConfirmMove] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(browserStorage(), roomId));
  const groups = useMemo(() => groupScenes(scenes), [scenes]);
  const folderGroups = groups.filter((g) => g.folder !== null);
  const folders = useMemo(() => groups.flatMap((g) => (g.folder === null ? [] : [g.folder])), [groups]);
  const notice = useSceneLoading();
  const loadingId = useDelayed(notice !== null) ? (notice?.sceneId ?? null) : null;
  const movingTo = useRoomView((s) => {
    for (const p of s.pending) if (p.op.t === "room.setPlayerScene") return p.op.sceneId;
    return null;
  });
  const moving = useDelayed(movingTo !== null) ? movingTo : null;
  const sight = useRoomView((s) => (s.view ? sightOf(s.view) : undefined));
  const warningFor = (scene: Scene) => moveWarning({ scene, viewing: scene.id === viewingId, sight });

  const movePlayers = (scene: Scene) => {
    if (warningFor(scene) !== null && confirmMove !== scene.id) {
      setConfirmMove(scene.id);
      return;
    }
    setConfirmMove(null);
    actions.dispatch({ t: "room.setPlayerScene", sceneId: scene.id });
  };

  const reorder = (order: string[] | null) => {
    if (order) actions.dispatch({ t: "scene.reorder", order });
  };

  const saveCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    writeCollapsed(browserStorage(), roomId, next);
  };

  const toggleFolder = (folder: string) => {
    const next = new Set(collapsed);
    if (!next.delete(folder)) next.add(folder);
    saveCollapsed(next);
  };

  const renameFolder = (from: string, to: string) => {
    sendFolderRename(actions, scenes, from, to);
    if (collapsed.has(from)) {
      const next = new Set(collapsed);
      next.delete(from);
      saveCollapsed(next.add(to));
    }
  };

  const row = (group: SceneGroup, scene: Scene, i: number) => {
    const viewing = scene.id === viewingId;
    const players = scene.id === playerSceneId;
    const loading = scene.id === loadingId;
    const name = scene.name || "Untitled";
    return (
      <li key={scene.id} style={{ padding: `${theme.space(1)}px 0`, borderTop: i === 0 ? undefined : `${theme.line.border}px solid ${theme.color.border}` }}>
        <div
          style={{
            display: "grid",
            gap: theme.space(1),
            padding: theme.space(1),
            borderRadius: theme.radius.md,
            // The scene you are on is the chosen one, its whole row in the accent's tint.
            border: `${theme.line.border}px solid ${viewing ? theme.color.accent : "transparent"}`,
            background: viewing ? theme.color.accentTint : "transparent",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
            <button
              type="button"
              onClick={() => actions.switchScene(scene.id)}
              aria-current={viewing ? "true" : undefined}
              aria-busy={loading || undefined}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 56,
                display: "flex",
                alignItems: "center",
                gap: theme.space(3),
                padding: theme.space(1),
                borderRadius: theme.radius.md,
                border: "none",
                background: "transparent",
                color: theme.color.text,
                fontFamily: theme.font.body,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <SceneThumb scene={scene} />
              <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
                <span style={{ ...oneLine, fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight }}>{name}</span>
                <span style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0, fontSize: theme.font.small, lineHeight: theme.leading.tight, color: theme.color.textMuted }}>
                  <span style={oneLine}>
                    {describe(scene)}
                    {loading ? " · " : viewing ? " · you are here" : ""}
                  </span>
                  {/* The row's button is the name a screen reader reads, so the wait is words in it, not a status of its own. */}
                  {loading ? <Loading small live={false} delay={0} text="loading…" style={{ flex: "none", whiteSpace: "nowrap", lineHeight: theme.leading.tight }} /> : null}
                </span>
              </span>
            </button>
            {arranging ? (
              <>
                <ArrowButton label={`Move ${scene.name} up`} icon="arrowUp" disabled={i === 0} onClick={() => reorder(moveScene(groups, scene.id, -1))} />
                <ArrowButton label={`Move ${scene.name} down`} icon="arrowDown" disabled={i === group.scenes.length - 1} onClick={() => reorder(moveScene(groups, scene.id, 1))} />
              </>
            ) : (
              <SceneMenuButton scene={scene} viewing={viewing} scenes={scenes} folders={folders} />
            )}
          </div>
          {arranging ? null : (
            // Lined up under the name, past the thumbnail. A button's line is a touch target tall, and words take their own height, as the tag does.
            <div style={{ display: "flex", alignItems: "center", minHeight: players || moving === scene.id ? undefined : theme.touch, paddingLeft: THUMB_WIDTH + theme.space(4) }}>
              {moving === scene.id ? (
                <Loading small delay={0} text="Moving players…" />
              ) : players ? (
                <Tag tone="turn">Players here</Tag>
              ) : (
                <Button size="sm" title={`Move players to ${scene.name}`} aria-label={`Move players to ${scene.name}`} onClick={() => movePlayers(scene)}>
                  Move players
                </Button>
              )}
            </div>
          )}
          {confirmMove === scene.id ? (
            <div role="alert" style={{ display: "flex", alignItems: "center", gap: theme.space(2), padding: `0 ${theme.space(1)}px`, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 100%", minWidth: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.warning }}>{warningFor(scene)}</span>
              <Button size="sm" onClick={() => setConfirmMove(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={() => movePlayers(scene)}>
                Move anyway
              </Button>
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  // The sheet's header already says "Scenes", so the list's own label says which ones (F25).
  return (
    <Section
      label="All scenes"
      divider={false}
      action={
        scenes.length > 1 ? (
          <Button size="sm" pressed={arranging} onClick={() => setArranging(!arranging)}>
            {arranging ? "Done" : "Reorder"}
          </Button>
        ) : null
      }
      style={{ gridTemplateColumns: "minmax(0, 1fr)", minWidth: 0 }}
    >
      {groups.map((group) => {
        const list = <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{group.scenes.map((scene, i) => row(group, scene, i))}</ul>;
        const folder = group.folder;
        if (folder === null) return <div key="loose">{list}</div>;
        const shut = collapsed.has(folder);
        const f = folderGroups.indexOf(group);
        const marks = [
          group.scenes.some((s) => s.id === playerSceneId) ? "players here" : null,
          shut && group.scenes.some((s) => s.id === viewingId) ? "you are here" : null,
        ].filter((m): m is string => m !== null);
        return (
          <div key={`folder:${folder}`}>
            <FolderHeader
              folder={folder}
              folders={folders}
              count={group.scenes.length}
              collapsed={shut}
              marks={marks}
              onToggle={() => toggleFolder(folder)}
              onRename={(to) => renameFolder(folder, to)}
              arrange={
                arranging
                  ? {
                      up: f > 0 ? () => reorder(moveFolder(groups, folder, -1)) : null,
                      down: f < folderGroups.length - 1 ? () => reorder(moveFolder(groups, folder, 1)) : null,
                    }
                  : null
              }
            />
            {shut ? null : list}
          </div>
        );
      })}
    </Section>
  );
}

/** An arrow that moves a scene or a folder while arranging. The arrow says nothing to a screen reader, so the label is its name. */
function ArrowButton(props: { label: string; icon: "arrowUp" | "arrowDown"; disabled: boolean; onClick(): void }) {
  return <Button size="sm" icon={props.icon} iconOnly="always" aria-label={props.label} disabled={props.disabled} onClick={props.onClick} />;
}

const oneLine = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/**
 * A scene's picture, 64 by 48 px: its own thumbnail, or until it has one the
 * map's small copy, or for a blank mat its background color. A picture
 * that fails to load falls through to the next.
 */
function SceneThumb(props: { scene: Scene }) {
  const { scene } = props;
  const assets = useAssets();
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const src = thumbSources(scene)
    .map((s) => assets.url(s.assetId, s.variant))
    .find((url) => !failed.has(url));
  return (
    <span
      aria-hidden
      style={{
        flex: "none",
        width: THUMB_WIDTH,
        height: 48,
        overflow: "hidden",
        borderRadius: theme.radius.sm,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: scene.background,
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed((f) => new Set(f).add(src))}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
    </span>
  );
}

/** The thumbnail's width, which the line under the name is indented by. */
const THUMB_WIDTH = 64;

/**
 * A folder's 44 px header: a tap folds it. Rename renames the folder on
 * every scene in it as one undo step, and says first when the new name is
 * another folder's, which merges the two. While arranging, it moves the
 * folder.
 */
function FolderHeader(props: {
  folder: string;
  /** Every folder's name, to tell when a rename merges this one into another. */
  folders: readonly string[];
  count: number;
  collapsed: boolean;
  marks: string[];
  onToggle(): void;
  onRename(to: string): void;
  arrange: { up: (() => void) | null; down: (() => void) | null } | null;
}) {
  const { folder, collapsed, count, arrange } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // A rename only Save sends keeps the sheet from a swipe's close (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(draft !== null && draft !== folder);

  if (draft !== null) {
    const merge = renameMergesInto(props.folders, folder, draft);
    const save = () => {
      const name = cleanFolderName(draft);
      if (name === null) {
        setInvalid(true);
        return;
      }
      props.onRename(name);
      setDraft(null);
    };
    return (
      <HeaderRow>
        <div style={{ flex: "1 1 160px", minWidth: 0, display: "flex" }}>
          <Input
            aria-label={`New name for the folder ${folder}`}
            autoFocus
            value={draft}
            maxLength={LIMITS.folderNameChars}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            style={{ flex: 1, width: "100%" }}
          />
        </div>
        <Button size="sm" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={save}>
          Save
        </Button>
        {invalid ? (
          <span role="alert" style={{ flexBasis: "100%", fontSize: theme.font.small, color: theme.color.warning }}>
            A folder name is 1 to {LIMITS.folderNameChars} characters on one line.
          </span>
        ) : merge !== null ? (
          <span role="status" style={{ flexBasis: "100%", minWidth: 0, fontSize: theme.font.small, color: theme.color.warning, overflowWrap: "anywhere" }}>
            {merge} already exists. Its scenes and these will share one folder.
          </span>
        ) : null}
      </HeaderRow>
    );
  }

  return (
    <HeaderRow>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={props.onToggle}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: theme.touch,
          display: "flex",
          alignItems: "center",
          gap: theme.space(2),
          padding: `0 ${theme.space(1)}px`,
          border: "none",
          borderRadius: theme.radius.md,
          background: "transparent",
          color: theme.color.text,
          fontFamily: theme.font.body,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ flex: "none", color: theme.color.textMuted }}>
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} />
        </span>
        <span style={{ minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
          <span style={{ ...oneLine, fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>{folder}</span>
          <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.tight, color: theme.color.textMuted }}>
            {count} {count === 1 ? "scene" : "scenes"}
            {props.marks.map((m) => ` · ${m}`).join("")}
          </span>
        </span>
      </button>
      {arrange ? (
        <>
          <ArrowButton label={`Move the folder ${folder} up`} icon="arrowUp" disabled={!arrange.up} onClick={() => arrange.up?.()} />
          <ArrowButton label={`Move the folder ${folder} down`} icon="arrowDown" disabled={!arrange.down} onClick={() => arrange.down?.()} />
        </>
      ) : (
        <Button size="sm" aria-label={`Rename the folder ${folder}`} title={`Rename the folder ${folder}`} onClick={() => setDraft(folder)}>
          Rename
        </Button>
      )}
    </HeaderRow>
  );
}

function HeaderRow(props: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: theme.space(2),
        marginTop: theme.space(2),
        padding: `${theme.space(1)}px 0`,
        borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      {props.children}
    </div>
  );
}

function describe(scene: Scene): string {
  const kind = scene.map ? "Map" : "Grid";
  const fog = scene.fogEnabled ? "fog on" : "fog off";
  return `${kind}, ${scene.bounds.w} × ${scene.bounds.h}, ${fog}`;
}
