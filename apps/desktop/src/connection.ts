import { randomUUID } from "node:crypto";
import type { CommandShell } from "@cooper/core";
import {
  IncompleteConfigError, mergeOnboardingConfig, parseSettings, providerProtocols,
  readSettingsDocument, resolveConfig, selectModelTier, userConfigFile,
  type Settings, type SettingsDocument,
} from "@cooper/host";
import type { ConnectionStatus } from "./ipc.js";

export class DesktopConnection {
  private edit?: { revision: string; document: SettingsDocument; settings: Settings };

  constructor(private readonly home?: string, private readonly windowsShell?: CommandShell) {}

  read(): ConnectionStatus {
    this.edit = undefined;
    try {
      const document = readSettingsDocument(this.home);
      const loaded = parseSettings(document.raw, document.file);
      let kind: "ready" | "incomplete" = "ready";
      try {
        selectModelTier(resolveConfig(loaded, { home: this.home, windowsShell: this.windowsShell }));
      } catch (error) {
        if (!(error instanceof IncompleteConfigError)) throw error;
        kind = "incomplete";
      }
      const settings = loaded.settings ?? {};
      const { protocol, baseURL, model, apiKey } = settings;
      const revision = randomUUID();
      this.edit = { revision, document, settings };
      return { kind, revision, fields: { protocol, baseURL, model }, hasKey: apiKey !== undefined };
    } catch (error) {
      return { kind: "invalid", file: userConfigFile(this.home),
        message: error instanceof Error ? error.message : "Could not read the configuration." };
    }
  }

  prepare(revision: unknown, value: unknown) {
    const edit = this.edit;
    if (!edit || revision !== edit.revision) throw new Error("Reopen model settings and try again.");
    const { document, settings } = edit;
    if (typeof value !== "object" || value === null) throw new Error("Enter the model connection settings.");
    const input = value as Record<string, unknown>;
    const protocol = providerProtocols.find((candidate) => candidate === input.protocol);
    const model = typeof input.model === "string" ? input.model.trim() : "";
    const baseURL = typeof input.baseURL === "string" ? input.baseURL.trim() : "";
    if (!protocol || !model || !baseURL) throw new Error("Enter a protocol, API address, and model ID.");
    const endpoint = URL.parse(baseURL);
    if (!endpoint || (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")) {
      throw new Error("Enter an absolute HTTP or HTTPS API address.");
    }
    const newKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const sameEndpoint = protocol === settings.protocol && baseURL === settings.baseURL;
    const apiKey = newKey || (sameEndpoint ? settings.apiKey : undefined);
    if (!apiKey) {
      throw new Error(settings.apiKey ? "Enter an API key for this protocol and address." : "Enter an API key.");
    }
    const values = mergeOnboardingConfig(document.raw, { protocol, model, baseURL, apiKey });
    const config = resolveConfig(parseSettings(values, document.file), { home: this.home, windowsShell: this.windowsShell });
    selectModelTier(config);
    return { document, values, config };
  }
}
