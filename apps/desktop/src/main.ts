import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { DesktopRuntime } from "./runtime.js";

function openWindow(): void {
  const page = path.join(__dirname, "index.html");
  const pageUrl = pathToFileURL(page).href;
  const window = new BrowserWindow({
    title: "Cooper Desktop", width: 1150, height: 790, minWidth: 690, minHeight: 510,
    show: false,
    backgroundColor: "#f5f2e9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const runtime = new DesktopRuntime((event) => {
    if (!window.isDestroyed()) window.webContents.send("cooper:event", event);
  });

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
  handle("cooper:send", (prompt) => {
    if (typeof prompt !== "string") throw new Error("Invalid message.");
    return runtime.send(prompt);
  });
  handle("cooper:stop", () => runtime.stop());
  handle("cooper:approve", (id, allowed) => {
    if (typeof id !== "string" || typeof allowed !== "boolean") throw new Error("Invalid approval.");
    return runtime.approve(id, allowed);
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
    void runtime.dispose().finally(() => app.quit());
  });
  void window.loadFile(page);
}

app.on("window-all-closed", () => app.quit());
void app.whenReady().then(openWindow);
