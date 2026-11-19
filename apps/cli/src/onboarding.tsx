import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { resolveContextWindow } from "@cooper/core";
import {
  defaultEndpoint, probeEndpoint, probeRequest, userConfigFile, type OnboardingResult, type ProtocolKind,
} from "@cooper/host";

/**
 * First-run setup: shown when any of protocol/model/baseURL/apiKey is
 * missing in an interactive session. Headless runs never enter this flow —
 * they fail closed with the IncompleteConfigError message.
 *
 * Connection checks and configuration writes are shared with Desktop.
 */

type Step =
  | "welcome"
  | "protocol"
  | "model"
  | "context"
  | "baseurl"
  | "key"
  | "checking"
  | "failed"
  | "ready";

const PROTOCOLS: { value: ProtocolKind; label: string }[] = [
  { value: "openai-chat", label: "OpenAI chat completions (OpenAI, DeepSeek, gateways)" },
  { value: "anthropic-messages", label: "Anthropic Messages (Claude native)" },
  { value: "openai-responses", label: "OpenAI Responses" },
];

/** Example only — shown as a placeholder; never auto-written as a default. */
const MODEL_PLACEHOLDER: Record<ProtocolKind, string> = {
  "openai-chat": "gpt-4o-mini",
  "anthropic-messages": "claude-opus-5-5",
  "openai-responses": "gpt-4o-mini",
};

function OnboardingApp({
  existing,
  onDone,
}: {
  existing: Partial<OnboardingResult>;
  onDone: (result: OnboardingResult | null) => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("welcome");
  const [protocolIndex, setProtocolIndex] = useState(
    Math.max(0, PROTOCOLS.findIndex(({ value }) => value === existing.protocol)),
  );
  const [model, setModel] = useState(existing.model ?? "");
  const [windowInput, setWindowInput] = useState(existing.contextWindow?.toString() ?? "");
  const [contextWindow, setContextWindow] = useState<number>();
  const [windowError, setWindowError] = useState(false);
  const [baseURL, setBaseURL] = useState(existing.baseURL ?? "");
  const [apiKey, setApiKey] = useState(existing.apiKey ?? "");
  const [keyScope, setKeyScope] = useState({
    protocol: existing.protocol,
    baseURL: existing.baseURL,
  });
  const [probeError, setProbeError] = useState("");

  const finish = (result: OnboardingResult | null) => {
    onDone(result);
    exit();
  };

  // Steps with a text input: single-letter keys (q) must not quit mid-typing.
  const isTextInputStep =
    step === "model" || step === "context" || step === "baseurl" || step === "key";

  useInput((input, key) => {
    if (key.escape || (input === "q" && !isTextInputStep)) {
      finish(null);
      return;
    }
    switch (step) {
      case "welcome":
        if (key.return) setStep("protocol");
        return;
      case "protocol":
        if (key.upArrow) {
          setProtocolIndex((i) => (i + PROTOCOLS.length - 1) % PROTOCOLS.length);
        } else if (key.downArrow) {
          setProtocolIndex((i) => (i + 1) % PROTOCOLS.length);
        } else if (key.return) {
          setStep("model");
        }
        return;
      case "failed":
        if (input === "r") setStep("checking");
        else if (input === "e") setStep("protocol");
        else if (input === "k") setStep("key");
        else if (input === "c") finish(currentResult());
        return;
      case "ready":
        if (key.return) finish(currentResult());
        return;
      default:
        return;
    }
  });

  const protocol = PROTOCOLS[protocolIndex]?.value ?? "openai-chat";
  const suggestedWindow = resolveContextWindow(model);
  const windowPlaceholder = suggestedWindow.window.toLocaleString("en-US");

  const currentResult = (): OnboardingResult => ({
    protocol,
    model: model.trim(),
    apiKey,
    baseURL: baseURL.trim(),
    contextWindow,
  });

  // Validation runs as an effect whenever we enter `checking`.
  useEffect(() => {
    if (step !== "checking") return;
    let cancelled = false;
    void (async () => {
      const result = await probeEndpoint(
        currentResult().protocol,
        baseURL,
        apiKey,
      );
      if (cancelled) return;
      if (result.ok) {
        setProbeError("");
        setStep("ready");
      } else {
        setProbeError(result.error);
        setStep("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Cooper setup
      </Text>
      {step === "welcome" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Complete the provider settings in config.json.
          </Text>
          <Text>
            Choose a protocol and model, then configure the endpoint and API key.
          </Text>
          <Text dimColor>
            Everything is stored in ~/.cooper/config.json (never in the
            workspace).
          </Text>
          <Box marginTop={1}>
            <Text>
              <Text bold>Enter</Text> to begin · <Text bold>q</Text> to quit
            </Text>
          </Box>
        </Box>
      )}
      {step === "protocol" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Which protocol does your endpoint speak?</Text>
          {PROTOCOLS.map((entry, index) => (
            <Text
              key={entry.value}
              color={index === protocolIndex ? "green" : undefined}
            >
              {index === protocolIndex ? "❯ " : "  "}
              {entry.label}
            </Text>
          ))}
          <Text dimColor>↑/↓ choose · Enter select · Esc quit</Text>
        </Box>
      )}
      {step === "model" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Model name (as your endpoint expects it):</Text>
          <TextInput
            value={model}
            onChange={setModel}
            onSubmit={(value) => {
              if (value.trim() === "") return;
              setModel(value.trim());
              setStep("context");
            }}
            placeholder={MODEL_PLACEHOLDER[protocol]}
          />
          <Text dimColor>
            Required — no built-in default. Example:{" "}
            {MODEL_PLACEHOLDER[protocol]}
          </Text>
          <Text dimColor>Enter to continue · Esc quit</Text>
        </Box>
      )}
      {step === "context" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Total context window in tokens (optional)</Text>
          <TextInput
            value={windowInput}
            placeholder={windowPlaceholder}
            onChange={(value) => {
              setWindowInput(value);
              setWindowError(false);
            }}
            onSubmit={(value) => {
              const trimmed = value.trim();
              const entered = Number(trimmed);
              if (trimmed !== "" && (
                !/^\d+$/.test(trimmed) || !Number.isSafeInteger(entered) || entered <= 0
              )) {
                setWindowError(true);
                return;
              }
              const tokens = trimmed === "" ? existing.contextWindow : entered;
              setContextWindow(tokens === existing.contextWindow ? undefined : tokens);
              setWindowInput(tokens?.toString() ?? "");
              setStep("baseurl");
            }}
          />
          {windowError && <Text color="red">Enter a positive whole number of tokens.</Text>}
          <Text dimColor>
            {existing.contextWindow !== undefined
              ? "Enter keeps the saved window unless you enter a different value."
              : suggestedWindow.assumed
                ? `Leave blank to use the estimated ${windowPlaceholder} token window.`
                : `Leave blank to use the model table's ${windowPlaceholder} token window.`}
          </Text>
        </Box>
      )}
      {step === "baseurl" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Base URL:</Text>
          <TextInput
            value={baseURL}
            onChange={setBaseURL}
            onSubmit={(value) => {
              // Empty Enter accepts the visible placeholder — still an
              // explicit choice that gets written; never applied silently.
              const resolved =
                value.trim() === "" ? defaultEndpoint(protocol) : value.trim();
              if (keyScope.protocol !== protocol || keyScope.baseURL !== resolved) {
                setApiKey("");
              }
              setBaseURL(resolved);
              setStep("key");
            }}
            placeholder={defaultEndpoint(protocol)}
          />
          <Text dimColor>
            Enter accepts the placeholder shown above · Esc quit
          </Text>
        </Box>
      )}
      {step === "key" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>API key (input hidden):</Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            mask="*"
            onSubmit={(value) => {
              if (value.trim() === "") return;
              setApiKey(value.trim());
              setKeyScope({ protocol, baseURL });
              setStep("checking");
            }}
          />
          <Text dimColor>Enter checks access to the models endpoint · Esc quit</Text>
        </Box>
      )}
      {step === "checking" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Checking {probeRequest(protocol, baseURL, apiKey).url} …</Text>
        </Box>
      )}
      {step === "failed" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">Model listing failed: {probeError}</Text>
          <Text>
            <Text bold>r</Text> retry · <Text bold>e</Text> edit connection ·{" "}
            <Text bold>k</Text> edit key ·{" "}
            <Text bold>c</Text> continue without verification ·{" "}
            <Text bold>q</Text> quit
          </Text>
        </Box>
      )}
      {step === "ready" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">✓ Model listing succeeded.</Text>
          <Text dimColor>The selected model is checked on the first chat request.</Text>
          <Text>
            Will write {userConfigFile()} with protocol{" "}
            <Text bold>{protocol}</Text>, model{" "}
            <Text bold>{model.trim()}</Text>, baseURL{" "}
            <Text bold>{baseURL.trim() || defaultEndpoint(protocol)}</Text>.
          </Text>
          <Box marginTop={1}>
            <Text>
              <Text bold>Enter</Text> to save and start · <Text bold>q</Text>{" "}
              to quit
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Runs the wizard to completion. Resolves with the chosen settings, or null
 * when the user aborts (the caller then prints manual instructions).
 */
export function runOnboarding(
  existing: Partial<OnboardingResult>,
): Promise<OnboardingResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OnboardingResult | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const app = render(<OnboardingApp existing={existing} onDone={finish} />);
    void app.waitUntilExit().then(() => finish(null));
  });
}
