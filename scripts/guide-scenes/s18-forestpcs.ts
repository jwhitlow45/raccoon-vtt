import { roomState, sceneByName, pcToken } from "./lib.ts";
export default async (c: any) => {
  const st = await roomState(c);
  const forest = sceneByName(st, "Forest road");
  const crypt = sceneByName(st, "Crypt");
  c.state.forest = forest.id;
  c.state.crypt = crypt.id;
  c.state.icons = {
    thorn: { icon: "kier-heyl/dwarf-helmet", color: "#1d4ed8" },
    bree: { icon: "delapouite/sun-priest", color: "#b45309" },
    mara: { icon: "darkzaitzev/hooded-figure", color: "#6d28d9" },
    ivo: { icon: "delapouite/wizard-face", color: "#0f766e" },
  };
  const ids: Record<string, string> = {};
  const spots: Record<string, [number, number]> = { thorn: [5, 10], bree: [4, 11], mara: [6, 11], ivo: [3, 10] };
  for (const [k, [x, y]] of Object.entries(spots)) ids[k] = await pcToken(c, forest.id, k, x, y, { image: c.state.icons[k] });
  c.state.forestPcs = ids;
  return { forest: forest.id, crypt: crypt.id, ids, playerScene: st.meta.playerSceneId };
};
