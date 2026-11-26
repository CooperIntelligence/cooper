# Cooper Code

Cooper Code is an AI coding agent for your terminal. Ask it to explore a codebase, edit files, run tests, or work through a task in a saved conversation.

## Install

Requires Node.js 22.12.0 or later.

```bash
npm install -g @cooper-intelligence/cooper-code
cooper
```

On first launch, choose a protocol and enter your model ID, endpoint, and API key. Cooper supports OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. The setup wizard saves your settings to `~/.cooper/config.json`.

## Usage

```bash
cooper --mode plan                  # explore a project with read-only tools
cooper -p "Explain the entry point" # get an answer for a script
cooper --sessions                   # find a saved conversation
cooper --help
```

Interactive `ask` mode lets you review file diffs, commands, and web requests before approving them. Headless `ask` denies those actions. On Windows, approved commands run as the current Windows user. The native installer includes PowerShell 7. The npm package uses the host shell. Windows supports `plan` and `ask`.

Use `/help` in the interactive UI to see available commands.

[Project repository](https://github.com/CooperIntelligence/cooper) · [MIT License](https://github.com/CooperIntelligence/cooper/blob/main/LICENSE)
