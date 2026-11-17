import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopEvent } from "./ipc.js";

const cooper: DesktopApi = {
  openWorkspace: () => ipcRenderer.invoke("cooper:open"),
  newChat: () => ipcRenderer.invoke("cooper:new"),
  restoreSession: (id) => ipcRenderer.invoke("cooper:restore", id),
  setMode: (mode) => ipcRenderer.invoke("cooper:mode", mode),
  send: (prompt) => ipcRenderer.invoke("cooper:send", prompt),
  stop: () => ipcRenderer.invoke("cooper:stop"),
  approve: (id, allowed) => ipcRenderer.invoke("cooper:approve", id, allowed),
  subscribe(listener) {
    const forward = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on("cooper:event", forward);
    return () => { ipcRenderer.removeListener("cooper:event", forward); };
  },
};

contextBridge.exposeInMainWorld("cooper", cooper);
