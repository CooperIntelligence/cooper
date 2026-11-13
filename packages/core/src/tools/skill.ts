import { z } from "zod";
import { readSkill, type SkillCatalog } from "../skills.js";
import type { Tool } from "./tool.js";

const schema = z.object({
  name: z.string().min(1).max(64).optional().describe("Name of a discovered skill. Omit to browse the catalog."),
  file: z.string().min(1).optional().describe("Optional text resource path relative to the skill directory."),
  offset: z.number().int().nonnegative().optional().describe("Index of the first skill to list when no name is given."),
});

export function createSkillTool(catalog: SkillCatalog): Tool<typeof schema> {
  return {
    name: "load_skill",
    description: "Load a skill, read one of its bundled text resources, or browse the catalog.",
    inputSchema: schema,
    capabilities: ["read"],
    summarize({ name, file }) {
      return name === undefined ? "List skills" : "Load " + name + (file === undefined ? "" : "/" + file);
    },
    async execute({ name, file, offset = 0 }) {
      if (name === undefined) {
        if (file !== undefined) throw new Error("Provide the skill name when reading a resource.");
        const page = Array.from(catalog.skills.values()).slice(offset, offset + 10)
          .map(({ name, description }) => ({ name, description }));
        const next = offset + page.length;
        return { content: JSON.stringify({ skills: page, nextOffset: next < catalog.skills.size ? next : null }) };
      }
      return { content: await readSkill(catalog, name, file) };
    },
  };
}
