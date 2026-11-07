import type { IconName } from "../../../components/Icon.tsx";
import type { SearchRoute } from "../entry.ts";
import type { CatalogEntry } from "./types.ts";

/*
 * How the catalogs write their sections, settings and actions
 * (designs/qol/search.md 5.10): each names the place it lives and its
 * anchor, the `data-search` id at its one `search=` prop, and the route
 * follows from them. An entry's id is its kind and its anchor, so it stays
 * the same in every index built for it and a recent pick finds it again.
 */

/** Where a group of entries lives: the route's panel, page and fold, and the words its rows show after their kind. */
export type Place = { panel: string; page?: string; section?: string; where: string; icon: IconName };

/** What an entry adds to its title and place: its other names, best bets, value, a when and a Suggested place. */
export type More = Pick<CatalogEntry, "names" | "bets" | "keys" | "value" | "description" | "when" | "valueNow" | "suggest"> & { icon?: IconName };

/** A place inside another, one fold or group further: its section and its name after the place's where. */
export function inside(place: Place, label: string, section?: string): Place {
  return { ...place, ...(section ? { section } : null), where: `${place.where} · ${label}` };
}

function route(place: Place, anchor: string | undefined, press: boolean): SearchRoute {
  return {
    panel: place.panel,
    ...(place.page ? { page: place.page } : null),
    ...(place.section ? { section: place.section } : null),
    ...(anchor ? { anchor } : null),
    ...(press ? { press: true } : null),
  };
}

function write(kind: "section" | "setting" | "action", place: Place, anchor: string, title: string, more: More, press: boolean): CatalogEntry {
  const { icon, ...rest } = more;
  return { id: `${kind}:${anchor}`, kind, title, where: place.where, icon: icon ?? place.icon, ...rest, act: { t: "open", route: route(place, anchor, press) } };
}

/** A fold or group of a panel, which the search opens and lands on its header. */
export function section(place: Place, anchor: string, title: string, more: More = {}): CatalogEntry {
  return write("section", place, anchor, title, more, false);
}

/** A page of a panel with no header of its own to land on, such as Menu's Members: the panel at that page. */
export function page(place: Place, id: string, title: string, more: More = {}): CatalogEntry {
  const { icon, ...rest } = more;
  return { id: `section:${id}`, kind: "section", title, where: place.where, icon: icon ?? place.icon, ...rest, act: { t: "open", route: route(place, undefined, false) } };
}

/** A setting, which the search focuses and rings, unchanged. */
export function setting(place: Place, anchor: string, title: string, more: More = {}): CatalogEntry {
  return write("setting", place, anchor, title, more, false);
}

/** An action, which the search presses once focused, so it meets the control's own confirm. `press: false` only goes there, for a control a press cannot start, such as a field to type in. */
export function action(place: Place, anchor: string, title: string, more: More & { press?: boolean } = {}): CatalogEntry {
  const { press = true, ...rest } = more;
  return write("action", place, anchor, title, rest, press);
}

/** A switch's value on its row (search.md 5.2). */
export function onOff(on: boolean): string {
  return on ? "On" : "Off";
}
