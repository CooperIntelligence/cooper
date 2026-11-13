import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverSkills, readSkill } from "../src/skills.js";
import { createSkillTool } from "../src/tools/skill.js";

let base: string;
let root: string;
let home: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "cooper-skills-"));
  root = path.join(base, "project");
  home = path.join(base, "home");
  await mkdir(root);
  await mkdir(home);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function addSkill(anchor: string, parent: string, name: string, manifest: string) {
  const directory = path.join(anchor, parent, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), manifest);
  return directory;
}

it("discovers native and shared skills, applies precedence, and keeps malformed files out", async () => {
  await addSkill(home, ".cooper/skills", "review", "---\nname: review\ndescription: User review\n---\nUser body");
  await addSkill(home, ".agents/skills", "format", "---\nname: format\ndescription: Shared formatting\n---\nFormatting body");
  await addSkill(root, ".agents/skills", "review", "---\nname: review\ndescription: Shared project review\n---\nShared body");
  const project = await addSkill(root, ".cooper/skills", "review",
    "\uFEFF---\r\nname: review\r\ndescription: >-\r\n  Review code for\r\n  correctness.\r\n---\r\nOriginal body");
  await addSkill(root, ".cooper/skills", "broken", "---\nname: broken\ndescription: [\n---\nBroken");
  await addSkill(root, ".cooper/skills", "wrong", "---\nname: other\ndescription: Mismatch\n---\nWrong");

  const catalog = await discoverSkills(root, home);
  expect([...catalog.skills.keys()]).toEqual(["review", "format"]);
  expect(catalog.skills.get("review")).toMatchObject({ scope: "project", description: "Review code for correctness." });
  expect(catalog.skills.get("format")).toMatchObject({ scope: "user" });
  expect(catalog.warnings).toHaveLength(4);
  expect(JSON.stringify([...catalog.skills.values()])).not.toContain("Original body");

  await writeFile(path.join(project, "SKILL.md"), "---\nname: review\ndescription: Updated\n---\nLatest body");
  const tool = createSkillTool(catalog);
  expect(tool.capabilities).toEqual(["read"]);
  const result = await tool.execute({ name: "review" }, { root });
  expect(JSON.parse(result.content)).toMatchObject({ name: "review", instructions: "Latest body" });
});

it("reads resources from a user skill and refuses path traversal and escaping links", async () => {
  const directory = await addSkill(home, ".agents/skills", "review", "---\nname: review\ndescription: Review\n---\nBody");
  await mkdir(path.join(directory, "references"));
  await writeFile(path.join(directory, "references", "checklist.md"), "Review checklist");
  await writeFile(path.join(root, "private.txt"), "Outside content");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(root, path.join(directory, "outside"), linkType);
  await symlink(root, path.join(home, ".agents", "skills", "escape"), linkType);
  const catalog = await discoverSkills(root, home);
  expect(catalog.skills.has("escape")).toBe(false);
  expect(JSON.parse(await readSkill(catalog, "review", "references/checklist.md"))).toMatchObject({ content: "Review checklist" });
  await expect(readSkill(catalog, "review", "../private.txt")).rejects.toThrow(/outside/);
  await expect(readSkill(catalog, "review", "outside/private.txt")).rejects.toThrow(/outside/);
  await expect(readSkill(catalog, "review", path.join(root, "private.txt"))).rejects.toThrow(/relative/);
});

it("rejects a discovered directory link retargeted to another skill", async () => {
  const parent = ".agents/skills";
  const target = await addSkill(root, parent, "target", "---\nname: target\ndescription: Target\n---\nTarget");
  const alias = path.join(root, parent, "alias");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const aliasTarget = path.join(root, parent, "alias-files");
  await mkdir(aliasTarget);
  await writeFile(path.join(aliasTarget, "SKILL.md"), "---\nname: alias\ndescription: Alias\n---\nOriginal alias");
  await symlink(aliasTarget, alias, linkType);
  const catalog = await discoverSkills(root, home);
  expect(catalog.skills.has("alias")).toBe(true);
  await unlink(alias);
  await symlink(target, alias, linkType);
  await expect(readSkill(catalog, "alias")).rejects.toThrow(/location changed/);
});
