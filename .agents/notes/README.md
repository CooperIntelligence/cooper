# Agent Notes

An Agent Note records a decision this repository made: the problem, what was decided, what lost and why, and what the decision cost. It carries the reasoning that code, tests, and reference documentation cannot — the part a future maintainer would otherwise reconstruct or re-litigate.

An Agent Note is not a tutorial, a changelog, a task plan, or an implementation walkthrough. If current code, tests, or documentation already states a fact, do not restate it here.

## Layout and naming

Every Agent Note has two axes, both encoded in its path — `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle** (the top-level folder) is the note's status, and the note moves between folders as that status changes:
  - **`proposed/`** — the decision is not built, or only partly built. Plans, migration steps, and open questions legitimately live here.
  - **`implemented/`** — the decision shipped. The note records what was decided and what was rejected, and is kept current with what actually shipped: when code later moves a file, renames a package, or changes a key or default, the note is updated in the same change to match. Facts only — paths, names, structure — never the decision itself.
  - **`rejected/`** — the proposal was considered and declined. Keep it only while its rationale prevents a tempting, meaningful mistake; otherwise delete the complete set.
- **Class** (the nested folder) is the kind of decision. See [Classification](#classification).

The date in the filename is when the topic was **first proposed**, per git history — for a new note, the date of the change that introduces it — not the date the note moved, was rewritten, or was archived. Use a kebab-case ASCII slug for the title so paths and links stay stable.

Cross-references between notes use relative Markdown links (`[topic](../../implemented/architecture/2026-…-….md)`), never bare prose or issue numbers, so they are mechanically checkable and survive moves between folders.

The active tree is the working inventory: browse its lifecycle/class folders or search the repository. Do not add a centralized `INDEX.md`; it duplicates path metadata and makes unrelated note changes contend on one file. Implemented notes with historical decision value but little future guidance move to the separate frozen `archived/` tree.

One note records one decision. Two independent decisions are two notes that link to each other.

## Classification

Each Agent Note belongs to exactly one class from this closed set. The set is fixed and no project may extend it. A new class is a contract revision, not a folder, a setting, or a per-project convention.

| Class | What it covers |
|---|---|
| `feature` | A new user- or caller-facing capability. |
| `bug-fix` | Corrects a defect or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behavior, or surface area without adding a capability. |
| `architecture` | A structural decision about the **shipped source** — how packages relate, what the runtime vocabulary is. |
| `process` | Tooling, policy, or workflow **around** the code — checks, the package manager, vendoring — not runtime behavior. |
| `testing` | Test infrastructure and strategy. |

The `architecture` / `process` line: **architecture** is about the source we ship; **process** is about the surrounding tooling and workflow. `refactor` is deliberately absent — it overlaps `simplification`, whose discriminator, "does observable behavior change?", already covers it. If no class fits, the decision is premature or should be split; do not create a seventh folder.

## When to write one

Add or update an Agent Note in the same change only for lasting decision rationale that code, tests, and existing documentation do not explain:

- why this shape instead of the obvious alternative;
- what was knowingly given up;
- an ownership, security, compatibility, or durability boundary;
- a condition under which the decision should be revisited or a capability reintroduced;
- a rejected option that will look attractive again.

Do not write a note for mechanical or local edits, including local UI presentation and interaction changes; for facts the code, tests, or reference documentation already state; for task plans, acceptance checklists, or implementation walkthroughs; or for change history, which git owns.

Updating the Agent Note that already owns the decision satisfies the rule; do not create a duplicate. A proposal for substantial future work starts in `proposed/`; a decision already made starts in `implemented/`.

**Every new note triggers a supersession check.** Search the active tree for older notes covering the same decision, mechanism, or rejected alternative, and classify any full or partial supersession in the same change. A fully superseded implemented note may be archived in that change if it meets the archive test, or deleted through the consolidation rule below. Partial supersession keeps both notes active and cross-linked. Do not defer a known overlap to a later cleanup.

## The file format

### The header block

The first three lines of every Agent Note are exactly:

```markdown
# Agent Note: <title>

Status: <status>
```

followed by a blank line. The `Status:` value is one of three forms, and agrees with the lifecycle folder the file sits in:

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <why, in one line>`

The status carries no date and no parenthetical: the filename holds the first-proposed date, git holds everything else. The rejection reason is the one status with content, because a rejected note's verdict is the fact readers come for. The `Status:` line appears exactly once, on line 3; a second one anywhere outside a code fence is a violation.

### The body skeleton

Every Agent Note opens its body with `## Problem` — the motivation, written to stand without the solution. What follows depends on the lifecycle. Recurring sections use these canonical names and nothing else; genuinely bespoke technical sections (package topology, wire contracts, schemas) remain free-form between the required ones.

**`proposed/`**

```markdown
## Problem
## Proposal
…bespoke sections…
## Alternatives considered
## Acceptance criteria
## Risks
```

`## Proposal` is the intended change and may speak in the future tense — plans, migration steps, and open questions belong here while the work is unbuilt. `## Acceptance criteria` says what observable state means done. `## Risks` covers both what could go wrong and what the change knowingly gives up.

**`implemented/`**

```markdown
## Problem
## Decision
…bespoke sections…
## Alternatives considered
## Consequences
```

`## Decision` describes shipped reality in the present tense, and the whole file is kept current with it. `## Consequences` records what the trade-off cost **and** bought. Proposal-era headings are spec-speak here and a check rejects them: `## Proposal`, `## Plan`, `## Migration plan`, and `## Acceptance criteria` may not appear in an implemented note. A `## Testing`, `## Deferred`, or `## Related` section is fine where it states present-tense fact.

**`rejected/`**

A rejected note is the proposal, frozen: it keeps whatever proposal-time sections it had, including `## Acceptance criteria` or `## Plan`, and the verdict lives on the `Status:` line. Only the header block, the `## Problem` opener, a `## Proposal` section, and the alternatives mandate below apply.

### Alternatives considered — mandatory

Every Agent Note carries an `## Alternatives considered` section: each genuine alternative and why it lost, one bold-led paragraph per alternative or a `### Why not <X>?` subsection per contested one.

Alternatives are recorded, never invented. If an older note's alternatives are genuinely unreconstructible from the record, say so in one honest sentence inside the section. Do not fabricate a debate, and do not delete the section.

A decision recorded without what it beat invites re-litigation — the failure Agent Notes exist to prevent.

### Moving between lifecycles

Moving a file between lifecycle folders means updating the `Status:` line and re-satisfying that folder's skeleton in the same change — a check fails the move otherwise:

- **`proposed/` → `implemented/`**: rewrite `## Proposal` into a present-tense `## Decision`; fold `## Acceptance criteria` and `## Risks` into `## Consequences` (or into a present-tense `## Testing`/`## Verification` section for what now pins the behavior); drop plans in favor of what shipped. Update any facts that changed during implementation.
- **`proposed/` → `rejected/`**: add the reason to the `Status:` line and freeze the file.
- **`implemented/` updates**: edit facts in place — paths, names, defaults, mechanisms — in the same change that alters them. Do not append change history. This is tracking where the decision lives, not rewriting the decision.
- **A note is never edited into a different decision.** Write a new note and cross-link the old one; a fully superseded note may be deleted only through the consolidation rule.

When a note moves, update its inbound links and its translation pairing record in the same change.

### Language

A note's content may be written in the project's working language. The structural tokens stay in English verbatim: `# Agent Note: `, `Status:`, `Archived:`, and the canonical section headings.

If the project keeps translated counterparts, name them `<name>.<lang>.md` and keep a pairing record `<name>.i18n.yaml` that binds both sides' content. A counterpart mirrors the source section-for-section and is re-recorded together with it; a translation that does not mirror the structure is not a counterpart. Pairing is optional unless the project's check requires it.

## Supersession and consolidation

An implemented note that is fully superseded may be consolidated into the current owning note and deleted. Before deletion, the owner must preserve every unique rationale, alternative, consequence, required verification, and named coverage gap; repair every inbound link; and delete the translated counterpart and pairing record in the same change. Partial supersession does not qualify: keep both notes cross-linked and update every fact that remains current.

Consolidation must not rewrite the old file into its opposite or rely on git history as the only copy of rationale.

A feature-addition note may be consolidated into the later removal note only when the feature is absent from production code, configuration, schemas, durable and wire formats, migration, and compatibility behavior; no current documentation presents it as available; and no test exercises it as supported behavior. The removal owner preserves the original motivation, why it no longer justified the feature, alternatives to full removal, the capability given up, conditions for reintroduction, and the verification of complete absence. Removing one transport, default, implementation, or presentation is partial supersession, as is any surviving durable data or compatibility handling.

## Archiving and deletion

Delete an implemented note that only describes small UI adjustments or purely mechanical changes; delete its source, translated counterpart, and pairing record together and repair or remove inbound links. A local bug fix, performance change, new capability, or substantive behavior decision does not qualify merely because its implementation is small.

Archive other implemented notes only when the shipped decision is complete, its rationale is unlikely to guide future work, and the record still has historical decision value. Keep a note active when its alternatives, ownership boundary, negative guarantee, durable or wire semantics, security rule, or reintroduction condition remains useful.

Never archive or delete a proposed note: reject an obsolete proposal. Keep a rejected note only while it prevents a plausible mistake; otherwise delete its complete set. Do not archive toward a quota; word count and age are discovery aids, never criteria.

The archive is path-encoded as `archived/{class}/yyyy-mm-dd-topic-title.md`; `implemented` is deliberately absent because only implemented notes can enter it. An archival change moves the complete set — the source and, when present, its translated counterpart and pairing record — retains `Status: implemented`, inserts the same `Archived: YYYY-MM-DD` line immediately below that status in every language file, re-records the pairing record, and repairs or deletes inbound links. The archive date may not predate the filename date. These are the only permitted content changes during archival. Existing title punctuation, blank-line layout, and language-switcher wording do not block archival; preserve them with the body.

### The frozen seal

Once sealed, every archived note is permanently frozen. Do not edit, translate, reformat, update, move, or delete it, and do not treat it as authority for current behavior. Documentation checks skip archived sources, including their outbound links; active prose may still link into an archived note when it intentionally cites history.

The archive root contains only `AGENTS.md`, `manifest.json`, and the six class directories. Each class directory contains regular files only — no subdirectories, no stray artifacts.

`archived/manifest.json` is the append-only seal:

```json
{
  "version": 1,
  "files": {
    "architecture/2026-01-01-example.md": "sha256:<hex>"
  }
}
```

Every artifact under `archived/<class>/` must have an entry whose SHA-256 matches its bytes. Existing entries may never change or disappear; new artifacts may only be appended. A trusted baseline — CI's pre-change commit — makes removal detectable. A sealed artifact admits no content exception: any change, move, or deletion is a violation.

## Mechanical checks

A repository adopting this contract should enforce these rules mechanically; semantic questions stay with review:

- **Structure** — the notes root contains only `README.md`, `AGENTS.md`, the three active lifecycles, and `archived/`; only the six fixed classes sit under them; every active note is at `{lifecycle}/{class}/yyyy-mm-dd-topic.md`; every archived note is at `archived/{class}/yyyy-mm-dd-topic.md`; no `INDEX.md`; no stray folders or files.
- **Format** — exact header; status agrees with the folder and appears once; `## Problem` first; required sections present; no proposal-era headings in `implemented/`; `## Alternatives considered` present.
- **Links** — every relative link in an active note resolves. Archived outbound links are exempt.
- **Pairs** — a translated counterpart mirrors the source's heading structure, carries the same status (and, when archived, the same archive date), and its pairing record matches both sides.
- **Archive** — every artifact is sealed with a matching hash; no seal changed or disappeared; metadata is correct; the set is complete.

Run the checks in the same change that edits the notes. A violation is fixed, not described.

## Deliberate non-goals

The checks deliberately do not decide:

- whether a note is warranted, or whether its decision is trivial;
- whether the chosen class is the right one;
- whether the alternatives are genuine or complete;
- whether an archived note still has value;
- whether two language sides say the same thing, beyond structure and hashes;
- whether a note's rationale is good.

Those are review questions. The checks keep the corpus structurally honest so review can spend its attention on the reasoning.
