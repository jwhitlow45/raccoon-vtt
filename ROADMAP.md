# Roadmap

This is where raccoon-vtt means to go from November 2026 to the end of
2027, and what it has decided not to do. It is a direction rather than a
promise: plans change as groups play with the app and report what they
need. [FEATURES.md](FEATURES.md) says what the app does today, and
[docs/design/mvp.md](docs/design/mvp.md) is the full planning list behind
it, with every feature sorted into what is built, what comes later and what
was skipped.

## What the project plans to do

**Stay a virtual tabletop for the table.** raccoon-vtt stays self-hosted
software for D&D groups playing the 2024 rules, made for phones first. New
work favors what a group needs during a session, whether everyone sits
around one table or some players join from elsewhere.

**Build the features waiting in the "Later" tier,** as time allows. These
are the ones [mvp.md](docs/design/mvp.md) lists today:

- Join requests that the DM approves.
- Several floors in one scene.
- Animated maps. They are built, behind a switch the server's owner turns on.
- A dungeon generator. It is built on squares, with five themes, secret doors, lights, dressing and a DM key. Edits to single rooms in the preview, hexes and adding a wing to an existing scene come next.
- Weather overlays.
- Ambient music and sound effects, kept in sync for everyone.
- An in-game calendar and time of day.

**Offer a desktop app.** A download for Windows, macOS and Linux that runs
the server on the DM's own computer, so players on the same network join in
their browsers with nothing to host. Everyone still plays in a web browser.

**Polish what is already there.** Most of the work in any month is making
existing features easier and more reliable, from what play sessions turn
up: the map and its tools, hex grids and the isometric view, dice, undo,
and the stat blocks. Accessibility gets the same attention, with keyboard
use, screen reader announcements, readable contrast and larger interface
sizes.

**Keep releases steady and safe.** Releases follow Semantic Versioning and
are built, signed and published by GitHub Actions, with a changelog entry
for each one. Dependencies are updated every week. Security reports are
answered and fixed within the times [SECURITY.md](SECURITY.md) promises,
and the latest release always receives the fixes.

**Make the project sturdier.** The documentation keeps pace with every
change. The project works toward the OpenSSF Best Practices silver badge,
and would welcome a second maintainer, so that it no longer depends on one
person.

## What the project does not plan to do

These were considered and set aside. [mvp.md](docs/design/mvp.md#19-skipped-and-why)
gives the full reasons.

- **Voice and video chat.** The app is built for a group in one room, and a
  remote player can join by Discord or a call.
- **A full character sheet builder.** D&D Beyond does this well, and a
  character can link to its sheet there instead.
- **Macros, scripting or a plugin system.** Features are built into the app
  instead, so every room works the same way.
- **Native phone and tablet apps.** The installable web app covers phones and
  tablets.
- **Monsters and art from outside the SRD.** The official sourcebooks are
  not openly licensed, so there is no legitimate source to ship them from.
  The custom monster editor covers monsters from books a group owns.
- **AI-generated art.** Every image that ships with the app comes from an
  openly licensed source and is credited in [CREDITS.md](CREDITS.md).
