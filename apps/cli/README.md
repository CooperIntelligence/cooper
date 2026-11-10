# Cooper Code

An AI coding agent for your terminal: read and write files, run commands, and
drive whole workflows — with approval-gated permissions (ask / auto / plan).

## Install

```bash
npm install -g @cooper-intelligence/cooper-code
```

Requires Node.js 20+.

## Usage

```bash
cooper                    # interactive TUI
cooper "fix the tests"    # one-shot, non-interactive
cooper --help
```

Put your API key in `.env` (or the shell environment):

```bash
COOPER_API_KEY=sk-...      # or OPENAI_API_KEY / ANTHROPIC_API_KEY
```

Long-term preferences — provider protocol, model, endpoint, context tuning —
live in `~/.cooper/config.json` (optionally overridden per project in
`<workspace>/.cooper/config.json`):

```json
{ "provider": "openai", "model": "gpt-4o-mini" }
```

Precedence per key: CLI flag > env > project config > user config > defaults.
Run `/status` in the TUI to see every effective value and where it came from.

## Documentation

Full documentation lives in the
[repository](https://github.com/CooperIntelligence/cooper).

## License

MIT
