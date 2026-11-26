import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopEvent } from "./ipc.js";

const cooper: DesktopApi = {
  windowsTitlebar: process.platform === "win32",
  openMenu: (id, x, y) => ipcRenderer.invoke("cooper:menu", id, x, y),
  getState: () => ipcRenderer.invoke("cooper:state"),
  getConnection: () => ipcRenderer.invoke("cooper:config"),
  testConnection: (revision, input) => ipcRenderer.invoke("cooper:config-test", revision, input),
  saveConnection: (revision, input) => ipcRenderer.invoke("cooper:config-save", revision, input),
  openConfigFolder: () => ipcRenderer.invoke("cooper:config-folder"),
  openWorkspace: () => ipcRenderer.invoke("cooper:open"),
  newChat: () => ipcRenderer.invoke("cooper:new"),
  restoreSession: (id) => ipcRenderer.invoke("cooper:restore", id),
  setMode: (mode) => ipcRenderer.invoke("cooper:mode", mode),
  saveDraft: (key, text) => ipcRenderer.invoke("cooper:draft", key, text),
  keepEditingDraft: (key) => ipcRenderer.invoke("cooper:draft-edit", key),
  submit: (key, input) => ipcRenderer.invoke("cooper:submit", key, input),
  continueTurn: (turnId, confirmReview) => ipcRenderer.invoke("cooper:continue", turnId, confirmReview),
  stop: (runId) => ipcRenderer.invoke("cooper:stop", runId),
  approve: (id, allowed) => ipcRenderer.invoke("cooper:approve", id, allowed),
  openLink: (url) => ipcRenderer.invoke("cooper:link", url),
  subscribe(listener) {
    const forward = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on("cooper:event", forward);
    return () => { ipcRenderer.removeListener("cooper:event", forward); };
  },
};

contextBridge.exposeInMainWorld("cooper", cooper);
