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

Run `cooper` once interactively — a guided setup asks for your protocol and
API key, verifies the key against the endpoint, and writes
`~/.cooper/config.json`:

```json
{
  "env": { "COOPER_API_KEY": "sk-..." },
  "protocol": "openai-chat",
  "model": "gpt-4o-mini"
}
```

No workspace files are ever read. Precedence per key:
`--env-file` > environment > `config.json` > defaults. `model` has no
default — it must be set explicitly (or via guided setup). Run `/status` in the
TUI to see every effective value and where it came from.

## Documentation

Full documentation lives in the
[repository](https://github.com/CooperIntelligence/cooper).

## License

MIT
