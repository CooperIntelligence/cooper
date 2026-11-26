import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cooperHome } from "../home.js";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function resolveSandboxProjectRoot(root: string): Promise<string> {
  const [resolved, profile] = await Promise.all([fs.realpath(root), fs.realpath(os.homedir())]);
  if (path.parse(resolved).root === resolved || contains(resolved, profile)) {
    throw new Error("Choose a project directory instead of a user profile or drive root as a writable workspace.");
  }
  const state = cooperHome();
  const configuration = path.join(state, "config.json");
  const resolveState = (entry: string) => fs.realpath(entry).catch((error) => {
    if (isMissing(error)) return entry;
    throw error;
  });
  const [statePath, configPath] = await Promise.all([resolveState(state), resolveState(configuration)]);
  if (contains(statePath, resolved) || contains(resolved, statePath) || contains(resolved, configPath)) {
    throw new Error("Choose a project directory separate from Cooper's configuration and sessions.");
  }
  return resolved;
}

/**
 * Resolve through existing filesystem entries, including symlinks and
 * junctions. For a new file, append the missing suffix to its real parent.
 */
export async function resolveInRoot(root: string, relative: string): Promise<string> {
  const rel = path.relative(root, path.resolve(root, relative));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path "${relative}" is outside the workspace`);
  }
  if (process.platform === "win32" && rel.split(path.sep).some(
    (segment) => /:|[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment),
  )) {
    // Win32 can reinterpret suffixes, streams, and device names on open.
    throw new Error(`Invalid Windows path "${relative}"`);
  }

  const realRoot = await fs.realpath(root);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const missing: string[] = [];
  let candidate = path.join(realRoot, rel);
  for (;;) {
    let resolved: string;
    try {
      resolved = await fs.realpath(candidate);
    } catch (error) {
      if (!isMissing(error) || candidate === realRoot) throw error;
      const entry = await fs.lstat(candidate).catch((statError: unknown) => {
        if (isMissing(statError)) return undefined;
        throw statError;
      });
      if (entry !== undefined) {
        throw new Error(`Cannot resolve path "${relative}" through a dangling link`);
      }
      missing.push(path.basename(candidate));
      candidate = path.dirname(candidate);
      continue;
    }
    if (resolved !== realRoot && !resolved.startsWith(rootPrefix)) {
      throw new Error(`Path "${relative}" is outside the workspace`);
    }
    return path.join(resolved, ...missing.reverse());
  }
}
