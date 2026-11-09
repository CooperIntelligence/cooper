import os from "node:os";
import path from "node:path";

/** Cooper's data directory: `COOPER_HOME` when set, otherwise `~/.cooper`. */
export function cooperHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COOPER_HOME?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".cooper");
}
