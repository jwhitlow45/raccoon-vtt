# Creature numbers: the meeting order

Status: built, 2026-11-26. It amends the meeting order of [design-v1-creature-numbers.md](design-v1-creature-numbers.md) sections 3, 5 and 6, and steps neither OP_VERSION nor SNAPSHOT_VERSION. Decisions D-261126-020 to 024.

## 1. The problem

Creatures the party meets in one batch take their numbers in the order `sys.meet` names them, and the step names them in id order. Ids now start with a random nonce (shared/ids.ts), so three Goblins the DM makes left to right and then shows read G2, G3 and G1 (live play 50, LP50-NUMBER-1). The DM's brackets (`previewNumbers`) rank the same way.

A board order for every meeting was built and dropped before it shipped. On a scene where players see for themselves the party meets a creature when any one player is sent it (`partyHolds`), so a meeting can hold creatures only P2 sees. Ranked by place, a Goblin only P2 sees standing above P1's Goblins moves P1's numbers, and P1 learns where it stands.

## 2. The rule

A player's numbers may depend only on what that player sees. Two rooms that differ only in creatures P1 is never sent, in where they stand and in the order they were made, give P1 the same numbers.

The base design still lets one thing through, as D-261110-216 chose: on a scene where players see for themselves, a number counts the creatures any player was sent, so P1 reading "Goblin 2" may learn that another player saw a Goblin first. This note keeps that and adds nothing to it. It does not let where those creatures stand or when they were made reach P1.

## 3. Options

- **Picked (D-261126-020): board order on floors where the party shares its sight, id order on floors where players see for themselves.** Where the party shares its sight, the party meets a creature only when the copy every player and the table display hold has it, so every creature of a meeting there is on every player's board, and each player can read the order off it. Where players see for themselves, the order stays the id order, which tells no one anything.
- **Creation order, by a counter every reader holds.** Rejected. No reader holds such a counter: an id seals its making time so that no one can read it. A counter would show every player the order in which the DM prepared creatures, and on a scene where players see for themselves the place of P1's creatures in it would turn on when creatures only P2 sees were made, which the twin in section 2 forbids. It also needs a stored field and a room format step.
- **Board order over only the creatures each reader sees.** Rejected as a rule of its own. A creature has one number for the whole table (D-261110-133 rejected numbers per viewer), so when P1 and P2 see different creatures no single numbering follows both boards. A total order across two such creatures may not read either one's place, and which players see a creature depends on where others stand. What is left of the option is the pick: board order where every member sees the same creatures.
- **A stable order fixed when the creatures are met.** Rejected. A number is already fixed when its creature is met, and the question is only the order within one meeting. Storing a rank at first sight adds a field, a format step and the same choice of order.

## 4. The order

`meetingOrder(state)` in shared/numbering.ts ranks creatures of one shown name on one scene (its main floor and every floor of it):

1. Creatures on a floor whose sight is the whole party's come first: the lowest floor first, then top to bottom (`y`), then left to right (`x`), each by the cell its footprint starts at on the map seen from above, whatever turn the isometric view takes.
2. Creatures on a floor where players see for themselves (`vision.perPlayer`) follow, in id order.
3. Ties go to the lower id.

Only creatures of one name on one scene number against each other, so the order between names and scenes matters only on a scene at its 100 names, where the name met first takes the last entry. There the lists below meet names in the id order of each name's first creature, as id order did before.

## 5. The meet step's ops

`sys.meet` must name its creatures in id order (shared/protocol.ts), and replay applies stored ops as they ran. So the step keeps the op as it is (D-261126-022): `meetingRuns(state, ids)` in shared/reducer/numbering.ts sorts each name's creatures on each scene by the meeting order, cuts that list wherever an id falls below the one before, and puts every name's first part in the first list, every name's second part in the second, and so on, each list sorted by id. server/rooms/meet.ts sends one `sys.meet` per list (more past 500 creatures). Applied in turn they meet each name in the meeting order. A meeting already in id order is one op, as before, and a meeting takes as many ops as the name with the most cuts needs.

The count of ops follows the same rule: on a shared floor it is worked out from creatures every player holds, and on a floor where players see for themselves each name's creatures are already in id order, so a cut there turns on ids alone.

Changing the reducer to sort the named ids itself was rejected: it would apply stored ops in a new order on replay, which needs a change format step and an older room's ops gated by version.

## 6. What the DM and each player see

- **Players** read the table's number as before. On a scene whose sight is the whole party's, creatures they see appear together and take their numbers top to bottom, then left to right: three Goblins in a row read Goblin 1, 2 and 3. On a scene where players see for themselves, they take their numbers in an order that looks arbitrary and is the same for every room that differs only out of their sight.
- **The DM** reads the same numbers, and the brackets on the DM's board (`previewNumbers`) rank by the meeting order, so a row of unseen Goblins reads "Goblin (1)", "Goblin (2)" and "Goblin (3)" left to right, and those are the numbers they take when the party sees them together.

## 7. Rooms already saved

- A room saved at room format 46 or later keeps every number it gave. Nothing is renumbered, since players already read those numbers, and the order applies only to meetings from this build on (D-261126-023).
- The numbering upgrade (`numberingUpgrade`), which settles a room saved before format 46 once at load, and an imported file of that age after its migration, uses the meeting order in all three places it used id order: of two creatures with one old number the first in meeting order keeps it, the 100 names kept are those whose first creature comes first, and the rest are met in that order. An import renews every id at random, so id order there was arbitrary.
- The upgrade stays a pure function of the state, so a reload before the room's next save settles the same numbers. A room an older build upgraded saved format 46 with its first commit, so it never runs again.

## 8. Formats

No step. The stored shape is unchanged, `sys.meet` keeps its schema, and the reducer applies it as before. An older build of format 60 or later replays the new ops exactly.

## 9. UI checklist

- **Loading states**: none new. Numbers arrive in the frame of the batch that meets their creatures, as before.
- **Keys and focus**: unchanged.
- **Screen readers**: unchanged words. "Goblin 2" and "Goblin, would be 3, not yet seen by the party" are read as before, and only which creature reads which number changes.
- **Large interface sizes**: unchanged. Labels keep their length.
- **The exact words shown**: no new UI words. FEATURES.md and the DM guide say the order (section 6). No screen changes, so the alignment sweep needs no new root.

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Three Goblins made left to right out of sight, then seen together, the party sharing its sight | Goblin 1, 2, 3 left to right, the DM's brackets the same before | numbering.order.test.ts "three Goblins made left to right", shared/reducer/numbering.test.ts "three Goblins made left to right and met together" |
| The same three seen by P1 alone where players see for themselves | id order | numbering.order.test.ts "three Goblins P1 alone is sent" |
| Twin: Goblins only P2 is sent stand above P1's in room A and below in room B, made in another order | P1's numbers and frames alike | numbering.order.test.ts "Goblins only P2 is sent" |
| Random twin over seeds, both kinds of scene | O1 to O4 in the file | numbering.order.test.ts random twin |
| Floors: a lower floor's creatures, and a floor where players see for themselves next to a shared one | lower first, the shared floors before the other | shared/numbering.test.ts previews |
| The step's lists | each rises in id, each name in meeting order, as few lists as the cuts need | shared/reducer/numbering.test.ts "each list rises in id" |
| The upgrade | the first in meeting order keeps a shared number, id order where players see for themselves | shared/reducer/numbering.test.ts upgrade |
| A batch meeting 501 creatures on one spot | two ops, 500 then 1 | server/rooms/meet.test.ts |

## 11. As built

- The order is one comparator, `meetingOrder(state)`, which `previewNumbers`, `meetingRuns` and `numberingUpgrade` share, so the brackets, the step and the upgrade never rank apart. It reads a floor's `vision.perPlayer` itself, since shared/project.ts, which holds `perPlayerScene`, imports shared/numbering.ts. A scene without floors ranks as level 0.
- `meetCandidates` still returns its creatures in id order, and the lists come from `meetingRuns`. Rule 2's first member that takes 1 is still found by id, since a group has at most one member without a number.
- The random twin runs on the room's state, not on the actor: the DM's op, the meet step's ops from server/rooms/meet.ts and P1's copy from `projectState`, with the real sight rules. So it runs thousands of seeds in seconds (`NUMBERING_ORDER_RUNS`), and the actor-level twin covers P1's frames. Its invariants are O1 to O4 in server/rooms/numbering.order.test.ts.
- The reducer tests' batch helper applies one `sys.meet` per list, as the actor does.
