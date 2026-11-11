import os from "node:os";
import path from "node:path";

/**
 * Cooper's data directory: `<user home>/.cooper`.
 *
 * This is a constant on purpose. Every persisted artifact (config, sessions,
 * MCP config) resolves through it. Keeping the anchor independent of Cooper
 * settings lets the CLI locate the configuration before loading it.
 * Tests inject an alternate directory as a function parameter instead.
 */
export function cooperHome(): string {
  return path.join(os.homedir(), ".cooper");
}
