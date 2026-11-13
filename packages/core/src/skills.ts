import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { resolveInRoot } from "./tools/paths.js";
import type { Message } from "./types.js";

const MANIFEST = "SKILL.md";
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const skillName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const metadataSchema = z.object({
  name: skillName,
  description: z.string().trim().min(1).max(1024),
});

export type Skill = {
  name: string;
  description: string;
  scope: "project" | "user";
  anchor: string;
  relativeDirectory: string;
  directory: string;
};

export type SkillCatalog = {
  skills: ReadonlyMap<string, Skill>;
  warnings: readonly string[];
};

function parseManifest(text: string) {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (!frontmatter || frontmatter.index !== 0) {
    throw new Error("Expected YAML frontmatter at the start of SKILL.md.");
  }
  const document = parseDocument(frontmatter[1] ?? "");
  if (document.errors[0]) throw new Error("Invalid YAML frontmatter.");
  const metadata = metadataSchema.safeParse({
    name: document.get("name"),
    description: document.get("description"),
  });
  if (!metadata.success) throw new Error("Expected a valid name and a description in SKILL.md.");
  return { ...metadata.data, body: text.slice(frontmatter[0].length).trim() };
}

async function readText(file: string, limit: number, prefixOnly = false): Promise<string> {
  if (!(await fs.stat(file)).isFile()) throw new Error("Expected a regular file.");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (!prefixOnly && length > limit) throw new Error("Skill file exceeds the 64 KiB read limit.");
    return buffer.subarray(0, Math.min(length, limit)).toString("utf8");
  } finally {
    await handle.close();
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Discover one level of skill folders. Project wins, then Cooper-native paths. */
export async function discoverSkills(root: string, home = os.homedir()): Promise<SkillCatalog> {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];
  const scopes = [{ anchor: root, scope: "project" }, { anchor: home, scope: "user" }] as const;

  for (const { anchor, scope } of scopes) {
    for (const parent of [".cooper/skills", ".agents/skills"]) {
      let skillsRoot: string;
      let entries: string[];
      try {
        skillsRoot = await resolveInRoot(anchor, parent);
        entries = await fs.readdir(skillsRoot);
      } catch (error) {
        if (!missing(error)) warnings.push("Could not scan " + path.join(anchor, parent) + ".");
        continue;
      }
      for (const entry of entries.sort()) {
        if (!skillName.safeParse(entry).success) continue;
        const relativeDirectory = path.join(parent, entry);
        const location = path.join(anchor, relativeDirectory, MANIFEST);
        try {
          const directory = await resolveInRoot(skillsRoot, entry);
          if (!(await fs.stat(directory)).isDirectory()) continue;
          const file = await resolveInRoot(directory, MANIFEST);
          const metadata = parseManifest(await readText(file, MAX_FRONTMATTER_BYTES, true));
          if (metadata.name !== entry) throw new Error("Skill name must match its directory.");
          const existing = skills.get(entry);
          if (existing) {
            warnings.push(location + " is shadowed by " + path.join(existing.directory, MANIFEST) + ".");
            continue;
          }
          skills.set(entry, { name: entry, description: metadata.description, scope, anchor, relativeDirectory, directory });
        } catch (error) {
          if (!missing(error)) {
            warnings.push(location + " — " + (error instanceof Error ? error.message : String(error)));
          }
        }
      }
    }
  }
  return { skills, warnings };
}

/** Resolve the same catalog entry again so retargeted links cannot expand access. */
export async function readSkill(catalog: SkillCatalog, name: string, file?: string): Promise<string> {
  const skill = catalog.skills.get(name);
  if (!skill) throw new Error("Unknown skill " + JSON.stringify(name) + ". Use /skills to see available skills.");
  const parent = await resolveInRoot(skill.anchor, path.dirname(skill.relativeDirectory));
  const directory = await resolveInRoot(parent, path.basename(skill.relativeDirectory));
  if (directory !== skill.directory) throw new Error("Skill location changed. Restart Cooper to rediscover skills.");

  if (file !== undefined) {
    if (path.isAbsolute(file) || /^[a-z]:/i.test(file)) throw new Error("Use a path relative to the skill directory.");
    const content = await readText(await resolveInRoot(directory, file), MAX_FILE_BYTES);
    return JSON.stringify({ name, file, content });
  }

  const manifest = parseManifest(await readText(await resolveInRoot(directory, MANIFEST), MAX_FILE_BYTES));
  if (manifest.name !== name) throw new Error("Skill name changed. Restart Cooper to rediscover skills.");
  return JSON.stringify({ name, directory, instructions: manifest.body });
}

/** Explicit activation puts the skill in context without relying on a model tool call. */
export async function skillActivation(catalog: SkillCatalog, name: string): Promise<Message> {
  return {
    role: "user",
    runtime: "skill",
    content: "The user selected this skill for their request. Apply its instructions within Cooper's permission rules.\n" +
      await readSkill(catalog, name),
  };
}
