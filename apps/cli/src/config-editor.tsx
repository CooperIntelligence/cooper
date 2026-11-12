import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { commandShellKinds } from "@cooper/core";

type Values = Record<string, unknown>;
type Field = {
  name: string;
  kind?: "number" | "boolean" | "shell";
  hint?: string;
  required?: boolean;
};

const FIELDS: readonly Field[] = [
  { name: "model", required: true },
  { name: "protocol", hint: "openai-chat, anthropic-messages, or openai-responses", required: true },
  { name: "baseURL", hint: "HTTP or HTTPS URL", required: true },
  { name: "apiKey", hint: "Replacement key", required: true },
  { name: "maxOutputTokens", kind: "number" },
  { name: "showReasoning", kind: "boolean" },
  { name: "mode", hint: "Startup default: plan or ask" },
  { name: "shell", kind: "shell", hint: `${commandShellKinds.join("/")} [absolute executable path]` },
  { name: "context.window", kind: "number" },
  { name: "context.reserveOutputTokens", kind: "number" },
  { name: "context.compact", kind: "boolean" },
  { name: "context.summaryModel" },
];

export function configFieldIndex(name: string): number {
  return name === "" ? 0 : FIELDS.findIndex((field) => field.name.toLowerCase() === name.toLowerCase());
}

function section(values: Values, name: string): Values {
  const value = values[name];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Values
    : {};
}

function fieldValue(values: Values, field: Field): string {
  const [name, property] = field.name.split(".", 2) as [string, string?];
  const value = property === undefined ? values[name] : section(values, name)[property];
  if (name === "apiKey") return typeof value === "string" && value !== "" ? "set" : "unset";
  if (field.kind === "shell") {
    const { kind, executable } = section(values, name);
    return [kind, executable].filter((part) => typeof part === "string").join(" ") || "default";
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "default";
}

function editField(values: Values, field: Field, input: string): Values {
  const text = input.trim();
  if (text === "" && field.required) return values;

  const [name, property] = field.name.split(".", 2) as [string, string?];
  const next = { ...values };
  const target = property === undefined ? next : { ...section(values, name) };
  const key = property ?? name;
  if (text === "") {
    delete target[key];
  } else if (field.kind === "number" && /^\d+$/.test(text)) {
    target[key] = Number(text);
  } else if (field.kind === "boolean" && (text === "true" || text === "false")) {
    target[key] = text === "true";
  } else if (field.kind === "shell") {
    const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(text);
    target[key] = { ...section(values, name), kind: match?.[1], executable: match?.[2] };
  } else {
    target[key] = text;
  }
  if (property !== undefined) next[name] = target;
  return next;
}

export function ConfigEditor({ initial, initialIndex, onSave, onCancel }: {
  initial: Values;
  initialIndex: number;
  onSave: (values: Values) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [index, setIndex] = useState(initialIndex);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const field = FIELDS[index]!;

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      onCancel();
      return;
    }
    if (key.escape) {
      if (editing) {
        setInput("");
        setEditing(false);
      } else {
        onCancel();
      }
      return;
    }
    if (editing) return;
    if (key.upArrow) setIndex((current) => (current + FIELDS.length - 1) % FIELDS.length);
    else if (key.downArrow) setIndex((current) => (current + 1) % FIELDS.length);
    else if (key.return) {
      setInput("");
      setEditing(true);
    } else if (key.ctrl && char === "s") onSave(draft);
  });

  return (
    <Box flexDirection="column">
      {editing ? (
        <Box height={1} overflow="hidden">
          <Text color="cyan">{field.name}{" > "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            placeholder={field.hint ?? (field.kind === "boolean" ? "true or false" : fieldValue(draft, field))}
            mask={field.name === "apiKey" ? "*" : undefined}
            onSubmit={(value) => {
              setDraft((current) => editField(current, field, value));
              setInput("");
              setEditing(false);
            }}
          />
        </Box>
      ) : (
        <Text wrap="truncate-end"><Text color="cyan">Config · {field.name}</Text>{"  "}{fieldValue(draft, field)}</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {editing
          ? `Enter stage · Esc back · blank ${field.required ? "keeps value" : "resets to default"}`
          : "↑/↓ browse · Enter edit · Ctrl+S save and apply · Esc cancel"}
      </Text>
    </Box>
  );
}
