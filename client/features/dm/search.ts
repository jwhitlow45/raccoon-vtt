import { action, inside, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";
import { visionOn } from "../vision/sightMode.ts";

/*
 * The DM panel and the DM's part of Members in the room search
 * (designs/qol/search.md 4 and 5.10). A DM's alone, so these entries load
 * with the DM's catalog only (catalog/dm.ts): nothing but that file
 * imports this one. The DM panel's controls that a DM menu item does the
 * same as (Follow me, Black out, Bring everyone here, Show a handout, View
 * as a player) have no entry here: the item is their one row, and they are
 * its twin (catalog/dm.ts TWINS).
 */

const DM: Place = { panel: "dm", where: "DM", icon: "dm" };
const HANDOUTS = inside(DM, "Handouts", "handouts");
const SCREENS = inside(DM, "Players' screens", "screens");
const PREVIEW = inside(DM, "Preview", "check");
const LINK = inside(DM, "Player link", "link");
const DISPLAY = inside(DM, "Table display", "display");

/** A group's own place: the panel with the group's fold, read as the panel's. */
const at = (group: Place): Place => ({ ...group, where: DM.where });

/** Party sight shows on a scene with party vision only (vision/PartySightToggle.tsx). */
function sightShown(ctx: SearchContext): boolean {
  const scene = ctx.state.sceneId ? ctx.state.view?.scenes[ctx.state.sceneId] : undefined;
  return scene !== undefined && visionOn(scene);
}

export const DM_PANEL_ENTRIES: readonly CatalogEntry[] = [
  section(at(HANDOUTS), "dm.handouts", "Handouts"),
  section(at(SCREENS), "dm.screens", "Players' screens", { names: ["players' maps"] }),
  section(at(PREVIEW), "dm.preview", "Preview", { names: ["check their view"] }),
  setting(PREVIEW, "dm.preview.party-sight", "Party sight", { names: ["party vision"], when: sightShown }),
  section(at(LINK), "dm.link", "Player link", { names: ["join link"] }),
  action(LINK, "dm.link.show", "Show the player link", { names: ["qr code"] }),
  section(at(DISPLAY), "dm.display", "Table display"),
  setting(DISPLAY, "dm.display.show-view", "Show my view on the table display"),
  action(DISPLAY, "dm.display.add", "Add a TV", { names: ["display code"] }),
  action(DISPLAY, "dm.display.open", "Open on this device", { names: ["open the table display"] }),
];

const MEMBERS: Place = { panel: "menu", page: "members", where: "Menu · Members", icon: "group" };
const JOINING = inside(MEMBERS, "Joining");
const PASSWORD = inside(MEMBERS, "Player password");
const DEVICES = inside(MEMBERS, "DM devices");
const DM_LINK = inside(MEMBERS, "DM link");
const DELETE = inside(MEMBERS, "Delete this room");

export const DM_MEMBERS_ENTRIES: readonly CatalogEntry[] = [
  section(MEMBERS, "menu.members.joining", "Joining", { names: ["join requests"] }),
  setting(JOINING, "menu.members.joining.mode", "How new players join", { names: ["ask to join"] }),
  section(MEMBERS, "menu.members.player-link", "Player link", { names: ["join link"] }),
  section(MEMBERS, "menu.members.password", "Player password"),
  setting(PASSWORD, "menu.members.password.new", "New player password"),
  action(PASSWORD, "menu.members.password.change", "Change the password", { names: ["sign out players"] }),
  section(MEMBERS, "menu.members.dm-devices", "DM devices", { names: ["co-dm"] }),
  action(DEVICES, "menu.members.dm-devices.add", "Add a DM device", { names: ["co-dm", "dm invite"] }),
  section(MEMBERS, "menu.members.dm-link", "DM link"),
  action(DM_LINK, "menu.members.dm-link.replace", "Replace the DM link"),
  section(MEMBERS, "menu.members.delete", "Delete this room", { names: ["delete room"] }),
  // The name typed is the delete's own first step, so the search only goes to the field.
  action(DELETE, "menu.members.delete.name", "Delete room", { press: false }),
];
