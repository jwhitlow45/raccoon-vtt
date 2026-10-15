import { Select } from "../../components/Field.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";

/**
 * The Phase menu in a computer's top bar (docs/design-v1-maps-vision.md
 * section 3.4): the scene on screen's phases, the one showing selected.
 * Choosing another switches the map at once, with no confirmation, as the
 * chips in the scene's settings do. A native select, so the keyboard and
 * screen readers work as they do everywhere else. It shows only to a DM
 * whose scene has more than one phase. Players never have a phase list.
 */
export function PhaseMenu() {
  const actions = useRoomActions();
  const dm = useRoomView((s) => s.you?.role === "dm");
  const scene = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined));
  const phases = scene?.phases;
  if (!dm || !scene || !phases || phases.length < 2) return null;
  return (
    <label style={{ flex: "none", display: "flex", alignItems: "center", gap: theme.space(2), fontSize: theme.font.small, color: theme.color.textMuted }}>
      Phase
      <Select
        aria-label="Map phase"
        title="Switch the map to another phase"
        value={scene.phaseId ?? phases[0]?.id}
        onChange={(e) => {
          const phaseId = e.target.value;
          if (phaseId !== scene.phaseId) actions.dispatch({ t: "scene.setPhase", sceneId: scene.id, phaseId });
        }}
        style={{ maxWidth: 200, padding: `0 ${theme.space(2)}px`, cursor: "pointer" }}
      >
        {phases.map((phase) => (
          <option key={phase.id} value={phase.id}>
            {phase.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
