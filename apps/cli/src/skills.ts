import { createSkillTool, skillActivation, type Message, type SkillCatalog } from "@cooper/core";
import { visiblePreviewText } from "./preview.js";

export async function resolveSkillPrompt(prompt: string, catalog?: SkillCatalog): Promise<{
  user: Message;
  activation?: Message;
}> {
  const user: Message = { role: "user", content: prompt };
  const invocation = /^\/skill(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!invocation) return { user };

  const name = invocation[1]?.match(/^\S+/)?.[0];
  if (!name) throw new Error("Usage: /skill <name> [request]");
  if (!catalog?.skills.size) throw new Error("No skills discovered. Add a SKILL.md under .cooper/skills or .agents/skills and restart Cooper.");
  return { user, activation: await skillActivation(catalog, name) };
}

export function formatSkills(catalog?: SkillCatalog): string {
  const lines = Array.from(catalog?.skills.values() ?? [], ({ name, scope, description }) =>
    name + " (" + scope + ") · " + description.replace(/\s+/g, " "));
  return visiblePreviewText([
    lines.length ? "Skills · use /skill <name> [request]" : "No skills discovered.",
    ...lines,
    ...(catalog?.warnings ?? []),
  ].join("\n"));
}

export function skillTools(catalog?: SkillCatalog) {
  return catalog?.skills.size ? [createSkillTool(catalog)] : [];
}
