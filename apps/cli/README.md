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
  "protocol": "openai-chat",
  "model": "gpt-4o-mini",
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "sk-..."
}
```

Both interactive and headless runs read provider settings from this file.
For legacy configs, move the endpoint and key out of the old `env` block
into `baseURL` and `apiKey`. Run `/status` in the TUI to inspect the
effective configuration.

Run `/config` while the TUI is idle to edit your settings. Browse with the
arrow keys and press Enter to edit a field. Press Enter again to stage its
value, then Ctrl+S from the field browser to save and apply the draft. Esc
cancels the draft from the browser. Use `/config model` to open a specific
field. API key input is masked. Use `/reload` for edits made outside Cooper.

The next prompt uses the applied settings and carries the current conversation
history to the configured endpoint. If validation or saving fails, Cooper
reports the problem and keeps using the previous settings. `--show-reasoning`
keeps precedence, and `mode` in the file continues to set the startup default.

Startup permission mode follows `--mode`, then a saved `plan` or `ask` when
resuming, then the `config.json` default, then `ask`. Use `--mode auto` to
enable automatic approvals for a new process. In an idle TUI, `/plan`,
`/ask`, and `/auto` switch the mode for the current process.

## Documentation

Full documentation lives in the
[repository](https://github.com/CooperIntelligence/cooper).

## License

MIT
