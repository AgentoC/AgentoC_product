"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentocDesktop", Object.freeze({
  writeText: (value) => ipcRenderer.invoke("desktop:write-text", value),
  retryService: () => ipcRenderer.send("desktop:retry"),
  onExternalOpenFailed: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = () => listener();
    ipcRenderer.on("desktop:external-open-failed", handler);
    return () => ipcRenderer.removeListener("desktop:external-open-failed", handler);
  },
}));
