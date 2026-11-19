import type { ConnectionInput, ConnectionStatus, DesktopApi, DesktopState } from "./ipc.js";

export function bindModelSetup(
  api: DesktopApi,
  onReady: (state?: DesktopState | null) => void,
  onError: (error: unknown) => void,
) {
  const dialog = document.querySelector<HTMLDialogElement>("#model-setup")!;
  const title = dialog.querySelector("#setup-title")!;
  const form = dialog.querySelector<HTMLFormElement>("#setup-form")!;
  const protocol = form.querySelector<HTMLSelectElement>("#setup-protocol")!;
  const address = form.querySelector<HTMLInputElement>("#setup-address")!;
  const model = form.querySelector<HTMLInputElement>("#setup-model")!;
  const key = form.querySelector<HTMLInputElement>("#setup-key")!;
  const keyNote = form.querySelector<HTMLElement>("#setup-key-note")!;
  const test = form.querySelector<HTMLButtonElement>("#setup-test")!;
  const save = form.querySelector<HTMLButtonElement>("#setup-save")!;
  const result = form.querySelector<HTMLElement>("#setup-result")!;
  const invalid = dialog.querySelector<HTMLElement>("#setup-invalid")!;
  const file = invalid.querySelector("#setup-file")!;
  const folder = invalid.querySelector<HTMLButtonElement>("#setup-folder")!;
  const recheck = invalid.querySelector<HTMLButtonElement>("#setup-recheck")!;
  const errorBox = dialog.querySelector<HTMLElement>("#setup-error")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("#setup-cancel")!;
  const reload = dialog.querySelector<HTMLButtonElement>("#setup-reload")!;

  let status: ConnectionStatus | undefined;
  let busy = false;
  let required = false;
  let editing = false;

  function setBusy(value: boolean): void {
    busy = value;
    for (const control of [protocol, address, model, key, test, save, folder, recheck, reload, cancel]) {
      control.disabled = value;
    }
  }

  function showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    errorBox.textContent = message.replace(/^Error invoking remote method '[^']+': Error: /, "");
    errorBox.hidden = false;
    reload.hidden = status?.kind === "invalid" || !/config\.json changed|Reopen model settings/.test(message);
  }

  function resetFeedback(): void {
    result.hidden = true;
    errorBox.hidden = true;
    reload.hidden = true;
    save.textContent = "Save without testing";
  }

  function updateFields(): void {
    address.placeholder = protocol.value === "anthropic-messages"
      ? "https://api.anthropic.com" : "https://api.openai.com/v1";
    const retainsKey = status?.kind !== "invalid" && status?.hasKey &&
      protocol.value === status.fields.protocol && address.value.trim() === status.fields.baseURL;
    key.required = !retainsKey;
    keyNote.hidden = !retainsKey;
    key.placeholder = retainsKey ? "Key is set" : "";
  }

  async function read(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const current = await api.getConnection();
      status = current;
      required = !editing && current.kind !== "ready";
      if (!editing && !required) {
        if (dialog.open) dialog.close();
        onReady();
        return;
      }
      dialog.toggleAttribute("data-required", required);
      cancel.hidden = required;
      resetFeedback();
      key.value = "";
      const broken = current.kind === "invalid";
      title.textContent = broken ? "Check model configuration" : required ? "Connect a model" : "Model settings";
      form.hidden = broken;
      invalid.hidden = !broken;
      if (broken) {
        file.textContent = current.file;
        showError(current.message);
      } else {
        protocol.value = current.fields.protocol ?? "";
        address.value = current.fields.baseURL ?? "";
        model.value = current.fields.model ?? "";
        updateFields();
      }
      if (!dialog.open) dialog.showModal();
      setBusy(false);
      (broken ? recheck : protocol).focus();
    } catch (error) {
      if (dialog.open) showError(error);
      else onError(error);
    } finally {
      setBusy(false);
    }
  }

  async function submit(saveSettings: boolean): Promise<void> {
    if (busy || !status || status.kind === "invalid" || !form.reportValidity()) return;
    const input: ConnectionInput = {
      protocol: protocol.value as ConnectionInput["protocol"],
      baseURL: address.value.trim(),
      model: model.value.trim(),
      ...(key.value.trim() ? { apiKey: key.value } : {}),
    };
    if (!saveSettings) resetFeedback();
    else errorBox.hidden = true;
    setBusy(true);
    try {
      if (saveSettings) {
        const state = await api.saveConnection(status.revision, input);
        dialog.close();
        onReady(state);
      } else {
        result.textContent = "Checking access to the models endpoint…";
        result.hidden = false;
        const response = await api.testConnection(status.revision, input);
        if (response.ok) {
          result.textContent = "Models endpoint reachable. Cooper checks the selected model on your first message.";
          save.textContent = "Save and continue";
        } else {
          result.hidden = true;
          showError(`Model listing failed. ${response.error}`);
        }
      }
    } catch (error) {
      if (!saveSettings) result.hidden = true;
      showError(error);
    } finally {
      setBusy(false);
      if (dialog.open) (saveSettings ? save : test).focus();
    }
  }

  form.addEventListener("input", () => {
    resetFeedback();
    updateFields();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(true);
  });
  test.addEventListener("click", () => { void submit(false); });
  recheck.addEventListener("click", () => { void read(); });
  reload.addEventListener("click", () => { void read(); });
  folder.addEventListener("click", () => { void api.openConfigFolder().catch(showError); });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (required || busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => { key.value = ""; });

  return {
    start: read,
    open() {
      if (busy || dialog.open) return;
      editing = true;
      void read();
    },
  };
}
