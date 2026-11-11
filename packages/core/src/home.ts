import os from "node:os";
import path from "node:path";

/**
 * Cooper's data directory: `<user home>/.cooper`.
 *
 * This is a constant on purpose. Every persisted artifact (config, sessions,
 * MCP config) resolves through it, so letting any configuration surface —
 * environment variables, `--env-file`, the config file's own `env` block —
 * relocate it would make the config's location depend on the config itself.
 * Tests inject an alternate directory as a function parameter instead.
 */
export function cooperHome(): string {
  return path.join(os.homedir(), ".cooper");
}
