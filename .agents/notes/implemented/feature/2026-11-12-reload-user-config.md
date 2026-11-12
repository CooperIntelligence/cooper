# Agent Note: Reload User Configuration Between Turns

Status: implemented

## Problem

Updating a model, endpoint, or credential during a conversation previously required restarting Cooper and resuming the session. Applying a partial edit would risk combining connection settings from different saves.

## Decision

The idle TUI reads and validates the entire user configuration when the user invokes `/reload` or saves a draft in `/config`. The editor changes fields in a copy of the saved document, with masked input for the API key. It uses the same atomic file writer as onboarding. Saving checks that the file still matches the editor's starting version, then replaces it with the validated draft. The TUI prepares the provider and command tool before saving and activates them after the write succeeds. The current permission policy stays in force because `mode` sets the startup default. MCP connections follow the startup trust configuration and lifecycle.

Anthropic tags signed continuation data with the originating endpoint and model. A replacement adapter accepts matching data and skips older records that lack that identity. Conversation text and tool results remain available across provider changes.

## Alternatives considered

**Watch the config file or reread it before every turn.** Either approach would let a save redirect the next request and its conversation history without an explicit action in Cooper. A command gives the user control over when the new endpoint starts receiving requests.

**Open the raw JSON in the TUI.** A field editor can mask the saved key and keep intermediate values in a draft until the whole configuration passes validation.

## Consequences

The user can save and apply settings directly in Cooper or use `/reload` after editing the file elsewhere. The next turn can send the existing conversation history to a different endpoint. `/status` reports the applied configuration.

The [single configuration source](../architecture/2026-11-11-single-provider-configuration-source.md) and [process-scoped permissions](2026-11-11-per-process-auto-authorization.md) still apply.
