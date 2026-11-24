import os from "node:os";
import path from "node:path";

declare const COOPER_BUILD_CHANNEL: string | undefined;

export const cooperBuildChannel = typeof COOPER_BUILD_CHANNEL !== "undefined" && COOPER_BUILD_CHANNEL === "internal"
  ? "internal" : "public";
export const cooperHomeName = cooperBuildChannel === "internal" ? ".cooper-internal" : ".cooper";

/**
 * Cooper's data directory under the user profile.
 *
 * This is a constant on purpose. Every persisted artifact (config, sessions,
 * MCP config) resolves through it. Keeping the anchor independent of Cooper
 * settings lets the CLI locate the configuration before loading it.
 * Tests inject an alternate directory as a function parameter instead.
 */
export function cooperHome(): string {
  return path.join(os.homedir(), cooperHomeName);
}
