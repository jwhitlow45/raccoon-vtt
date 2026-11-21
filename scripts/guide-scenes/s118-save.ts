import { writeFileSync } from "node:fs";
export default async (c: any) => {
  const dir = `${c.WORK}`;
  writeFileSync(`${dir}/dm-state.json`, JSON.stringify(await c.state.dmContext.storageState()));
  writeFileSync(`${dir}/pat-state.json`, JSON.stringify(await c.state.patContext.storageState()));
  const keep = { roomId: c.state.roomId, forest: c.state.forest, crypt: c.state.crypt, tower: c.state.tower, lair: c.state.lair, chars: c.state.chars, icons: c.state.icons, cryptPcs: c.state.cryptPcs, dragon: c.state.dragon, password: c.state.password };
  writeFileSync(`${dir}/room-state.json`, JSON.stringify(keep, null, 2));
  return keep.roomId;
};
