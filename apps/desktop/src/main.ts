import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { DraftStore } from "./drafts.js";
import type { DesktopEvent } from "./ipc.js";
import { webLink } from "./links.js";
import { DesktopRuntime } from "./runtime.js";

function openWindow(): void {
  const page = path.join(__dirname, "index.html");
  const pageUrl = pathToFileURL(page).href;
  const icon = path.join(__dirname, "assets", "cooper-icon-512.png");
  app.dock?.setIcon(icon);
  const window = new BrowserWindow({
    title: "Cooper Desktop", width: 1150, height: 790, minWidth: 690, minHeight: 510,
    icon,
    show: false,
    backgroundColor: "#edf3fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const emit = (event: DesktopEvent) => {
    if (!window.isDestroyed()) window.webContents.send("cooper:event", event);
  };
  const drafts = new DraftStore(path.join(app.getPath("userData"), "drafts"), (key, error) => {
    emit({ type: "draft-error", key, message: `Could not save draft: ${String(error)}` });
  });
  const runtime = new DesktopRuntime(emit, drafts);

  function handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (window.isDestroyed() ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== pageUrl) {
        throw new Error("Untrusted desktop request.");
      }
      return handler(...args);
    });
  }

  handle("cooper:state", () => runtime.getState());
  handle("cooper:open", async () => {
    const selection = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    const directory = selection.filePaths[0];
    return selection.canceled || !directory ? null : runtime.openWorkspace(directory);
  });
  handle("cooper:new", () => runtime.newChat());
  handle("cooper:restore", (id) => {
    if (typeof id !== "string") throw new Error("Invalid session.");
    return runtime.newChat(id);
  });
  handle("cooper:mode", (mode) => {
    if (mode !== "ask" && mode !== "plan") throw new Error("Unsupported permission mode.");
    return runtime.setMode(mode);
  });
  handle("cooper:draft", (key, text) => {
    if (typeof key !== "string" || typeof text !== "string") throw new Error("Invalid draft.");
    runtime.saveDraft(key, text);
  });
  handle("cooper:draft-edit", (key) => {
    if (typeof key !== "string") throw new Error("Invalid draft.");
    return runtime.keepEditingDraft(key);
  });
  handle("cooper:send", (prompt) => {
    if (typeof prompt !== "string") throw new Error("Invalid message.");
    return runtime.send(prompt);
  });
  handle("cooper:continue", (turnId, confirmReview) => {
    if (typeof turnId !== "string" || (confirmReview !== undefined && typeof confirmReview !== "boolean")) {
      throw new Error("Invalid continuation request.");
    }
    return runtime.continueTurn(turnId, confirmReview);
  });
  handle("cooper:stop", (runId) => {
    if (runId !== undefined && typeof runId !== "string") throw new Error("Invalid run.");
    runtime.stop(runId);
  });
  handle("cooper:approve", (id, allowed) => {
    if (typeof id !== "string" || typeof allowed !== "boolean") throw new Error("Invalid approval.");
    return runtime.approve(id, allowed);
  });
  handle("cooper:link", (url) => {
    const address = typeof url === "string" ? webLink(url) : undefined;
    if (!address) throw new Error("Invalid web link.");
    return shell.openExternal(address);
  });

  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  window.once("ready-to-show", () => window.show());
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void runtime.dispose().catch((error) => console.error(error)).finally(() => app.quit());
  });
  void window.loadFile(page);
}

app.on("window-all-closed", () => app.quit());
void app.whenReady().then(openWindow);
