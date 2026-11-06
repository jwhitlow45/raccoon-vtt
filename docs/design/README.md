# Design notes

These notes are how raccoon-vtt was designed and built, one feature at a
time. Each one says what was asked for, the rules the feature follows, the
cases it was tested against, and where the build went its own way. Code
comments and tests cite them by file name and section, so a note keeps its
name once it is written.

Start with [design.md](design.md), the technical design of the app as it
stands. The notes below each add one feature or one pass to it. For what
the app does today in plain words, read [FEATURES.md](../../FEATURES.md),
and for how to use it, the [DM guide](../dm-guide.md).

## The core

- [design.md](design.md): the whole app's technical design, from rooms and
  sign-in to the board, sync, storage and security.
- [mvp.md](mvp.md): the planning list behind FEATURES.md. It sorts every
  feature into MVP, v1, Later or Skip, and says why each skipped one was
  skipped.
- [design-v1-maps-vision.md](design-v1-maps-vision.md): waves 3 and 4, with
  maps, walls, party vision, lights and raised ground.
- [design-v1-dm-tools.md](design-v1-dm-tools.md): wave 5, with the DM tools,
  notes and safety tools, image sources, device settings and stat blocks.
- [design-v1-log-history.md](design-v1-log-history.md): keeping the room's
  log history, and reading back older lines.
- [design-v1-join-requests.md](design-v1-join-requests.md): join requests
  the DM approves, and the three ways new players can join a room.

## Maps and the board

- [design-v1-grid-detect.md](design-v1-grid-detect.md): finding the grid
  drawn on a map image when it is imported.
- [design-v1-paste.md](design-v1-paste.md): pasting images from the
  clipboard.
- [design-v1-starter-art.md](design-v1-starter-art.md): the openly licensed
  starter packs DMs can pick art from.
- [design-v1-pdf-handouts.md](design-v1-pdf-handouts.md): PDF handouts.
- [design-v1-movement.md](design-v1-movement.md): movement that walks around
  walls and counts difficult terrain.
- [design-v1-snap-off.md](design-v1-snap-off.md): dropping a token between
  squares for one drag, drawn off its square while every rule still counts it
  in the square.
- [design-v1-heights-readout.md](design-v1-heights-readout.md): how players
  see the height of raised ground.
- [design-v1-per-player-vision.md](design-v1-per-player-vision.md): each
  player seeing only what their own character sees.
- [design-v1-map-discovery.md](design-v1-map-discovery.md): the map as the
  party discovers it, and setting up a scene.
- [design-v1-traps.md](design-v1-traps.md): triggers and traps.
- [design-v1-hex-grids.md](design-v1-hex-grids.md): hex grids beside
  squares.
- [design-v1-isometric-view.md](design-v1-isometric-view.md): an isometric
  view of the board.
- [design-v1-iso-area-shapes.md](design-v1-iso-area-shapes.md): areas drawn
  as their real shapes in the isometric view.
- [design-v1-iso-hex-relief.md](design-v1-iso-hex-relief.md): raised hexes
  in the isometric view.
- [design-v1-relief-pan.md](design-v1-relief-pan.md): keeping the raised
  ground's picture smooth while the board pans.
- [design-v1-area-from-character.md](design-v1-area-from-character.md): a
  player's area of effect placed from their own character.
- [design-v1-dungeon-generator.md](design-v1-dungeon-generator.md): making a
  whole dungeon from a few choices and a seed, as a Builder scene.

## Tokens and characters

- [design-v1-token-panel.md](design-v1-token-panel.md): the Token panel, the
  stat summary and AC on tokens.
- [design-v1-token-panel-groups.md](design-v1-token-panel-groups.md): the
  Token panel grouped by use.
- [design-v1-token-sections.md](design-v1-token-sections.md): what each
  section of a token holds.
- [design-v1-token-window.md](design-v1-token-window.md): the resizable token
  window, and changing a creature's size on the fly.
- [design-v1-bar-dock.md](design-v1-bar-dock.md): the token action bar,
  docked to the screen's edge.
- [design-v1-bar-compact.md](design-v1-bar-compact.md): a smaller resting
  token bar on upright phones.
- [design-v1-attach.md](design-v1-attach.md): attached tokens, such as a
  rider on a mount or a torch on a character.
- [design-v1-pc-stats.md](design-v1-pc-stats.md): stat blocks for player
  characters.
- [design-v1-companion-stat-blocks.md](design-v1-companion-stat-blocks.md):
  full stat blocks for companions.
- [design-v1-ddb-resources.md](design-v1-ddb-resources.md): class resources
  imported from D&D Beyond.
- [design-v1-resync.md](design-v1-resync.md): syncing a character from D&D
  Beyond again, keeping the changes made by hand.
- [design-v1-known-forms.md](design-v1-known-forms.md): the Wild Shape forms
  a Druid has prepared.
- [design-v1-monster-uses.md](design-v1-monster-uses.md): how a monster's
  limited uses show.

## Dice and combat

- [design-v1-dice.md](design-v1-dice.md): dice rolled on the server, the
  contract every roll follows.
- [design-v1-dice-ui.md](design-v1-dice-ui.md): a pass on the Dice panel and
  stat blocks.
- [design-v1-dice-pass.md](design-v1-dice-pass.md): the Dice page's
  collapsible sections and creature card.
- [design-v1-roll-animation.md](design-v1-roll-animation.md): the roll
  animation.
- [design-v1-roll-mode-menu.md](design-v1-roll-mode-menu.md): a menu on a
  roll button to make one roll with advantage, with disadvantage or in
  secret.
- [design-v1-roll-options.md](design-v1-roll-options.md): rolling from a
  creature's stat block, and the group save.
- [design-v1-roll-request.md](design-v1-roll-request.md): the DM's roll
  request, made shorter.
- [design-v1-stat-block-rolls.md](design-v1-stat-block-rolls.md): rolling
  from a stat block's ability boxes.
- [design-v1-token-roll-header.md](design-v1-token-roll-header.md): the
  Dice panel's result line and dice on a token's panel and a character's
  page.
- [design-v1-player-save-spell.md](design-v1-player-save-spell.md): a
  player casting a spell that calls for a save.
- [design-v1-combat-flow.md](design-v1-combat-flow.md): changes to running a
  fight in the tracker, such as the sticky round header and auto
  initiative.
- [design-v1-combat-controls.md](design-v1-combat-controls.md): a creature's
  combat uses in the combat section, such as legendary actions, recharge
  and class resources.
- [design-v1-undo-scope.md](design-v1-undo-scope.md): Undo during play, and
  reopening a group save.

## Panels, tools and layout

- [design-v1-layout-hierarchy.md](design-v1-layout-hierarchy.md): the
  screen's layout and what stands out on it.
- [design-v1-panel-tabs.md](design-v1-panel-tabs.md): the side panel's tabs
  in one row, with a More menu.
- [design-v1-split-panel.md](design-v1-split-panel.md): two panels open at
  once in the side panel.
- [design-v1-side-headers.md](design-v1-side-headers.md): short, matching
  headers in the side panel.
- [design-v1-sheet-swipe.md](design-v1-sheet-swipe.md): swiping a phone's
  bottom sheet down to close it or up to fill the screen.
- [design-v1-tool-options.md](design-v1-tool-options.md): a tool's options
  in one row.
- [design-v1-tool-cycle.md](design-v1-tool-cycle.md): pressing a tool's key
  again to move through its main choice.
- [design-v1-calendar.md](design-v1-calendar.md): the in-game calendar and
  time of day, with the Time panel in the side panel and a chip in the top
  bar.

## The look

- [design-v1-visual.md](design-v1-visual.md): the first visual design pass
  across the app.
- [design-v1-look-pass.md](design-v1-look-pass.md): the look pass that made
  the screens one product.
- [design-v1-look-pass-2.md](design-v1-look-pass-2.md): the second look
  pass, for the features that came after the first.
- [design-v1-design-pass.md](design-v1-design-pass.md): the design pass over
  the whole app.
- [design-v1-polish.md](design-v1-polish.md): a polish pass, checked by
  measurement.
- [design-v1-spacing-pass.md](design-v1-spacing-pass.md): the spacing pass.
- [design-v1-icons.md](design-v1-icons.md): icons across the app.
- [design-v1-icons-2.md](design-v1-icons-2.md): the second icon pass.
- [design-v1-guide-look.md](design-v1-guide-look.md): the DM guide laid out
  like a printed guide.
- [design-v1-look-pass-1.md](design-v1-look-pass-1.md): locked controls that
  look locked, roll menus that fit a small screen, toasts kept clear of an
  open sheet, and long damage formulas that break between terms.
- [design-v1-light-theme.md](design-v1-light-theme.md): a light theme each
  device picks in This device, with the board kept dark and member colors
  made readable on light ground.
- [design-v1-weather.md](design-v1-weather.md): weather over the map, one per
  scene, with a wind, the SRD's roll rules where they need no judgment, and
  each device's choice of how it looks.
- [design-v1-animated-maps.md](design-v1-animated-maps.md): a WebM or MP4
  loop over a map's still, off until the server's owner turns it on, with
  a header check that zeroes metadata in place and each device's choice of
  Moving or Still.
- [design-v1-video-turns.md](design-v1-video-turns.md): animated maps
  that turn, mirror or stretch their picture, as phone videos do, and an
  iPhone's MOV, rewritten plain at upload and drawn turned by the app.
- [design-v1-music.md](design-v1-music.md): synced music, background
  sounds and effects the DM plays from the Sound panel, off until the
  server's owner turns it on, with a frame check that decodes nothing and
  each device's choice to play.
