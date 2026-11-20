# Agent Notes Directory

This directory follows the contract in `README.md`. Read it before adding,
moving, or archiving a note.

- Active notes live in `proposed/`, `implemented/`, or `rejected/`, under one of
  the six fixed classes.
- Every non-trivial change adds or updates a note in the same change; only a
  purely mechanical or local edit with no behavioral, contractual, structural,
  process, or rationale change is exempt.
- `proposed/` records decisions that are not built yet, or only partly built.
- `implemented/` records shipped decisions and is kept current with the code.
- Archived notes are frozen; see `archived/AGENTS.md`.
- Verification is currently manual. When this repository gains a notes check,
  wire the contract's mechanical checks into it.

Durable decisions belong here. `.agents/research/` is local research material,
is ignored by git, and is not a decision record.
