/**
 * Which raw picture each guide picture is made from, and the webp quality
 * for the few busy ones, for scripts/guide-scenes.ts. The key is the file in
 * docs/dm-guide/, the value the raw shot a step in scripts/guide-scenes/
 * takes (the step's c.shot name).
 */
// ddb-resources.webp and resync.webp show "Last synced on" the day of the run, so a rerun differs from the committed pictures in that date alone.
// screen-phone.webp is taken by scripts/guide-music.ts, so the DM phone shot s108 makes (final-screen-phone) has no picture here.
export const PICTURES: Record<string, string> = {
  "home-create": "home-create",
  "screen-computer": "final-screen-computer",
  "scenes-panel": "final-scenes",
  "scenes-new-map": "scenes-new-map",
  "grid-line-up": "final-grid-lineup",
  "builder": "final-builder",
  "doors": "final-secret-door",
  "heights": "final-heights",
  "vision-settings": "final-vision-settings",
  "fog": "final-fog",
  "export": "look-export-grid",
  "monsters": "final-monster-page",
  "encounters": "final-encounters",
  "action-bar": "final-action-bar",
  "conditions": "look-group-conditions",
  "initiative": "final-initiative",
  "dice": "final-dice",
  "request": "final-request",
  "roll-card": "final-dm-card",
  "areas": "final-areas",
  "group-save": "look-groupsave",
  "alerts": "final-boss-recharge",
  "movement": "mv-movement",
  "walking-ruler": "extra-walking-ruler2",
  "attach": "at-attach2",
  "mounted-turn": "extra-mounted",
  "trap-pane": "tr-pane3",
  "trap-card": "tr-card",
  "resync": "rs-review",
  "outliner": "final-outliner",
  "dm-panel": "final-dm-panel",
  "pc-stats": "final-pc-stats",
  "companion": "look-owl-form",
  "pin": "final-pin",
  "table-display": "final-table-display",
  "room-settings": "final-room-settings",
  "ambush-reveal": "look-goblins-selected",
  "ambush-fireball": "final-ambush-fireball",
  "crypt-build": "final-crypt-walls",
  "crypt-player": "final-crypt-player",
  "heights-build": "final-heights-build",
  "heights-fireball": "final-heights-fireball",
  "boss": "final-boss-p170",
  "guardians": "final-guardians",
  "travel-outliner": "final-travel-outliner",
  "reveal-blackout": "look-pat-blackout",
  "shortcuts": "final-shortcuts-r3",
  "shortcuts-toolbar": "final-shortcuts-toolbar",
  "starter-maps": "final-starter-maps",
  "starter-token": "final-starter-token",
  "paste-offer": "final-paste-offer",
  "known-forms": "final-known-forms",
  // Guide pass 2's new pictures, drafted in phase 1 (s139 to s143). Phase 2 picks at most 6.
  "class-resources": "final-class-resources",
  "phone-strip": "final-phone-strip",
  "uses": "final-uses",
  "regeneration": "final-regeneration",
  "ddb-resources": "rs-review-resources",
  // Guide pass 3: the driver's own takes of pictures lanes made elsewhere, and the new ones.
  "scene-settings-folded": "gp3-scene-settings-folded",
  "scene-settings-map": "gp3-scene-settings-map",
  "token-view-as": "gp3-viewas2-panel",
  "copy-settings": "gp3-copy-settings",
  "hex-line-up": "gp3-hex-lineup",
  // Guide pass 4's new pictures (s150 to s155b).
  "hex-walls": "gp4-hex-walls",
  "hex-stairs": "gp4-hex-stairs-a",
  "hex-squeeze": "gp4-hex-ride-drag",
  "hex-find": "gp4-hex-find-shape",
  "uvtt-lights": "gp4-lamplit",
  // Guide pass 5's new pictures (s55b, s49, s69b, s108b).
  "dice-roll-menu": "gp5-rollmenu",
  "group-save-reopened": "gp5-undo-reopen-a",
  "log-export": "gp5-log-export",
  "sheet-handle": "gp5-sheet-handle",
  // Guide pass 6: the driver's own take of the stat block rolls picture, and the new ones (s157 to s159).
  "stat-block-rolls": "gp6-blockroll-list",
  "stat-block-roll-header": "gp6-blockroll-header",
  "corridor-riders": "gp6-narrow",
  "held-group-save": "gp6-heldsave",
  // Guide pass 7: Features on a phone (s160).
  "features": "gp7-features",
};

/**
 * Pictures that show something different on every run: a room's id, a player password, a code for a TV.
 * The run leaves them out unless GUIDE_ONLY names them, so it never replaces a picture with an equal one that only
 * differs in those characters.
 */
export const VARIES = new Set(["home-create", "pin", "table-display"]);

/** Busy maps are encoded lower so each stays near 100 KB, and the small crops higher so their text stays sharp. */
export const QUALITY: Record<string, number> = { "hex-find": 62, "hex-line-up": 62, "stat-block-roll-header": 88, "held-group-save": 88 };
