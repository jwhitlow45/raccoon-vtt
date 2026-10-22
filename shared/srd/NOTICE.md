# SRD 5.2.1 notice

This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

## Changes

The SRD 5.2.1 material in this folder was converted to JSON and Markdown and edited. It is in `monsters.json`, `area-spells.json`, `save-spells.json`, `rules-text.json` and `xp-budget.json`, in the rules text that `conditions.ts` and `statuses.ts` show from `rules-text.json`, and in the trap presets in `traps.ts`.

- The stat blocks, conditions and rules entries were split into fields and reformatted as Markdown. The line breaks and hyphenation of the PDF were removed.
- Em dashes were replaced with other punctuation.
- A few errors in the SRD were corrected. `scripts/srd-import.ts` lists each one with its reason.
- The spell area presets in `area-spells.json` summarize the area that each spell's text describes.
- `save-spells.json` summarizes what a successful save takes in the text of each spell that deals damage on a save: half the damage or none.
- The XP Budget per Character table is in `xp-budget.json`, one row per character level.
- The trap presets in `traps.ts` summarize the SRD's example traps: their triggers, saves, damage, conditions, checks and pit depths at each level range their tables give, and in each preset's note the rest of its entry. Poisoned Darts deals two of its darts.

The summaries, labels and colors in `conditions.ts` and `statuses.ts`, the notes in `area-spells.json`, and the players' lines and sounds of the trap presets, are this app's own and are not part of the SRD.

This app is compatible with fifth edition.
