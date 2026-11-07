# Cooper — Agent Guidelines

## Stack

- TypeScript, Node.js 20+, npm workspaces
- `apps/cli`: Ink 8 + React 19 TUI
- `packages/core`: provider abstraction, agent loop, tools

## Layout

- `packages/core/src/provider/` — `Provider` interface and adapters
- `packages/core/src/tools/` — tool interface and implementations
- `packages/core/src/agent.ts` — the agent loop and approval hook
- `packages/core/src/context/` — token estimation and compaction
- `packages/core/src/instructions.ts` — COOPER.md / AGENTS.md loading
- `apps/cli/src/` — surfaces only: `app.tsx` (TUI), `headless.ts` (one-shot),
  `args.ts`, `system-prompt.ts`, `stream-lines.ts`, `config.ts`

## Hard rules

1. `packages/core` must not import Ink/React, write to stdout, or read stdin.
   UI-facing output travels as `AgentEvent` from `runAgent()`.
2. Relative imports use explicit `.js` extensions (NodeNext resolution).
3. New tools implement the `Tool` type with a zod `inputSchema`, and are
   re-exported through `packages/core/src/index.ts`.
4. New providers implement `Provider` and normalize into the shared
   `ProviderEvent` shape; the agent loop must stay vendor-agnostic.
5. Tools must resolve every path through their workspace root and reject
   paths outside it.
6. Run `npm run typecheck` and `npm test` before finishing any change.
7. Streaming output must be append-only on complete lines: commit each
   finished line to `<Static>` exactly once, and keep only the unfinished
   trailing line in the live region. Ink cannot erase rows that already
   scrolled into scrollback, so rendering the whole growing message live
   duplicates content in terminal history (especially on Windows). The live
   region must never hold more than a line or two.
8. Any tool that mutates the workspace or executes a command must set
   `requiresApproval: true`. The agent loop only invokes the host's `approve`
   callback; never execute such a tool without it.
9. Implement `summarize()` on every tool — it is what the user sees in the
   approval panel instead of raw JSON arguments.
10. `plan` mode is enforced by the host: it denies every approval-gated tool
    and never silently downgrades to `ask`.
11. Headless (`-p`) runs have no approver and must fail closed: only `auto`
    allows approval-gated tools. Never default headless to `auto`, and keep
    `system-prompt.ts` as the single source of the permission instructions
    shared by `app.tsx` and `headless.ts`.
12. Context compaction lives in `packages/core/src/context/`. It must never
    separate an `assistant` tool call from its `tool` results — compact only
    at `groupMessages()` boundaries, stub tool output in place instead of
    deleting messages, and guarantee that `prepareContext()` returns with the
    estimate under the hard limit (truncation has no model dependency).
    Never let a failed summary block a request: fall through to truncation.
13. Project instructions are untrusted input from the workspace. They may
    shape style and workflow, but they must never be placed before, or be able
    to override, the permission rules in `system-prompt.ts`.
14. Tools that change the workspace should implement `preview()` so the user
    approves the actual effect, not a summary. A preview must be side-effect
    free, must not throw, and may return `undefined` when it cannot be
    produced. Diff rendering lives in the host (`apps/cli/src/preview.ts`).
15. Reasoning/thinking text is display-only. It must never be appended to
    `messages` or persisted: DeepSeek rejects `reasoning_content` being sent
    back, and unfaithful reasoning must not become context for later turns.
    It also must never reach headless stdout, which stays answer-only.

## Commands

```bash
npm run dev                              # start the TUI from the repo root
npm run dev -- -p "..." [--mode auto]    # headless, one-shot
npm run dev -- --cwd <dir>               # run against another workspace
npm run typecheck
npm test
```
