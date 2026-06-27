const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("devbox", {
  connect: () => ipcRenderer.send("app:connect"),
  openChannel: (id, cols, rows) => ipcRenderer.send("channel:open", { id, cols, rows }),
  input: (id, data) => ipcRenderer.send("channel:input", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("channel:resize", { id, cols, rows }),
  closeChannel: (id) => ipcRenderer.send("channel:close", { id }),

  onData: (cb) => ipcRenderer.on("channel:data", (_e, p) => cb(p)),
  onChannelStatus: (cb) => ipcRenderer.on("channel:status", (_e, p) => cb(p)),
  onAppStatus: (cb) => ipcRenderer.on("app:status", (_e, s) => cb(s)),
  onReady: (cb) => ipcRenderer.on("app:ready", () => cb()),

  clipboardRead: () => ipcRenderer.invoke("clipboard:read"),
  clipboardWrite: (text) => ipcRenderer.send("clipboard:write", text),

  termMenu: (id, hasSelection) => ipcRenderer.send("term:menu", { id, hasSelection }),
  onTermCopy: (cb) => ipcRenderer.on("term:copy", (_e, id) => cb(id)),
  onTermPaste: (cb) => ipcRenderer.on("term:paste", (_e, id) => cb(id)),
  onTermSelectAll: (cb) => ipcRenderer.on("term:selectall", (_e, id) => cb(id)),

  onCtlNav: (cb) => ipcRenderer.on("ctl:nav", (_e, u) => cb(u)),
  onCtlToggle: (cb) => ipcRenderer.on("ctl:toggle", () => cb()),
  onCtlDevtools: (cb) => ipcRenderer.on("ctl:devtools", () => cb()),
  onCtlSsh: (cb) => ipcRenderer.on("ctl:ssh", () => cb()),
  onCtlSess: (cb) => ipcRenderer.on("ctl:sess", () => cb()),

  connList: () => ipcRenderer.invoke("conn:list"),
  connSave: (profile) => ipcRenderer.send("conn:save", profile),
  connDelete: (id) => ipcRenderer.send("conn:delete", id),
  connActivate: (id) => ipcRenderer.send("conn:activate", id),
  onConnChanged: (cb) => ipcRenderer.on("conn:changed", () => cb()),
  onReset: (cb) => ipcRenderer.on("app:reset", () => cb()),

  sessionList: () => ipcRenderer.invoke("session:list"),
  sessionCreate: (name) => ipcRenderer.send("session:create", name),
  sessionRename: (from, to) => ipcRenderer.send("session:rename", { from, to }),
  sessionDelete: (name) => ipcRenderer.send("session:delete", name),
  sessionActivate: (name) => ipcRenderer.send("session:activate", name),
  onSessionChanged: (cb) => ipcRenderer.on("session:changed", () => cb()),
});
