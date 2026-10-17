import { useStore } from "zustand";
import { useScoped } from "../../state/scope.ts";
import { MonsterEditor } from "./MonsterEditor.tsx";
import { closeEditor, openEditor, openEditorsSlot, type EditorRequest } from "./openEditors.ts";

/**
 * Draws the stat block editors open on this page (openEditors.ts). The
 * Room mounts it beside its page, so an editor stays through anything that
 * changes what the page shows, a blackout included.
 */
export function EditorHost() {
  const store = useScoped(openEditorsSlot);
  const list = useStore(store, (s) => s.list);
  return (
    <>
      {list.map((e) => (
        <MonsterEditor
          key={e.key}
          monster={e.monster}
          initial={e.initial}
          {...(e.block ? { block: e.block } : {})}
          {...(e.paste ? { paste: true } : {})}
          onClose={() => closeEditor(store, e.key)}
          onSaved={(id, block) => {
            closeEditor(store, e.key);
            e.onSaved?.(id, block);
          }}
        />
      ))}
    </>
  );
}

/** Opens a stat block editor over the room, held by EditorHost rather than by the caller. */
export function useOpenEditor(): (request: EditorRequest) => void {
  const store = useScoped(openEditorsSlot);
  return (request) => {
    openEditor(store, request);
  };
}
