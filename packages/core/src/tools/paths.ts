import path from "node:path";

/**
 * Resolve a user/model supplied path against the workspace root and reject
 * anything that escapes it.
 */
export function resolveInRoot(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (rel === "") return absolute;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path "${relative}" is outside the workspace`);
  }
  return absolute;
}
