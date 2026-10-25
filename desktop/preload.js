// Bridges the welcome screen and the dashboard to the app. The main process only answers our own pages.
const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("a2aDesktop", {
  platform: process.platform,
  status: () => ipcRenderer.invoke("desktop:status"),
  onStatus: subscribe("desktop:status"),
  signOut: () => ipcRenderer.invoke("desktop:signOut"),
  startLink: () => ipcRenderer.invoke("desktop:startLink"),
  cancelLink: () => ipcRenderer.invoke("desktop:cancelLink"),
  onLink: subscribe("desktop:link"),
  openUrl: (url) => ipcRenderer.invoke("desktop:openUrl", url),
  info: () => ipcRenderer.invoke("desktop:info"),
});

// Lets the pages leave room for the window controls and make the top bar draggable.
addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("desktop", `desktop-${process.platform}`));
