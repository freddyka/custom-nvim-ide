const { app, BrowserWindow, ipcMain, clipboard, Menu } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const { Client } = require("ssh2");

// Standard-Verbindung. Ueberschreibbar per Umgebungsvariablen (DEVBOX_HOST/PORT/USER/KEY)
// oder im SSH-Manager der App. Die eigene Verbindung wird in connections.json gespeichert.
const CONN = {
  host: process.env.DEVBOX_HOST || "127.0.0.1",
  port: Number(process.env.DEVBOX_PORT || 22),
  username: process.env.DEVBOX_USER || os.userInfo().username,
  keyPath: process.env.DEVBOX_KEY || path.join(os.homedir(), ".ssh", "id_ed25519"),
};

// Startbefehl je Zelle: jede Zelle haengt an EINER eigenen, persistenten tmux-Session.
// "-A" = anhaengen falls vorhanden, sonst erstellen -> ueberlebt App-Neustart.
const STARTUP = {
  edit: "clear; tmux new-session -A -s edit nvim\n",
  shell: "clear; tmux new-session -A -s shell\n",
  ai: "clear; tmux new-session -A -s ai\n",
  shell2: "clear; tmux new-session -A -s shell2\n",
};

// Dev-Ports, die lokal (Windows/127.0.0.1) auf den Laptop getunnelt werden.
const FORWARD_PORTS = [3000, 4173, 5173, 8000, 8080];

let win = null;
let conn = null;
let connecting = false;
let ready = false;
const channels = {}; // id -> ssh2 stream
let forwardServers = [];

// SSH-Verbindungsprofile (verwaltbar ueber den SSH-Button in der Leiste)
let connFile = null;
let connections = [];
let activeId = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function loadConnections() {
  connFile = path.join(app.getPath("userData"), "connections.json");
  try {
    const data = JSON.parse(fs.readFileSync(connFile, "utf8"));
    connections = data.connections || [];
    activeId = data.activeId || null;
  } catch (_) {
    connections = [];
  }
  if (!connections.length) {
    connections = [{
      id: "default", name: "devbox",
      host: CONN.host, port: CONN.port, username: CONN.username, keyPath: CONN.keyPath,
    }];
    activeId = "default";
    saveConnections();
  }
  if (!activeId || !connections.find((c) => c.id === activeId)) activeId = connections[0].id;
}
function saveConnections() {
  try { fs.writeFileSync(connFile, JSON.stringify({ connections, activeId }, null, 2)); } catch (_) {}
}
function activeProfile() {
  return connections.find((c) => c.id === activeId) || connections[0] || CONN;
}
function teardown() {
  Object.keys(channels).forEach((id) => { try { channels[id].close(); } catch (_) {} delete channels[id]; });
  forwardServers.forEach((s) => { try { s.close(); } catch (_) {} });
  forwardServers = [];
  if (conn) { try { conn.end(); } catch (_) {} }
  conn = null;
  ready = false;
  connecting = false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: "#181825",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

function setupForward(localPort, remotePort) {
  const server = net.createServer((sock) => {
    if (!conn || !ready) {
      sock.destroy();
      return;
    }
    conn.forwardOut("127.0.0.1", localPort, "127.0.0.1", remotePort, (err, up) => {
      if (err) {
        sock.destroy();
        return;
      }
      sock.pipe(up).pipe(sock);
      sock.on("error", () => up.destroy());
      up.on("error", () => sock.destroy());
    });
  });
  server.on("error", (e) => console.log("[fwd] " + localPort + " Fehler: " + e.message));
  server.listen(localPort, "127.0.0.1", () =>
    console.log("[fwd] localhost:" + localPort + " -> " + remotePort)
  );
  forwardServers.push(server);
}

function expandKeyPath(p) {
  if (p && p.indexOf("~") === 0) return path.join(os.homedir(), p.slice(1));
  return p;
}

function connectSSH() {
  if (conn || connecting) return;
  const profile = activeProfile();
  connecting = true;
  conn = new Client();

  conn.on("ready", () => {
    ready = true;
    connecting = false;
    console.log("[ssh] verbunden mit " + profile.host);
    send("app:status", "verbunden: " + profile.name);
    send("app:ready", true);
    FORWARD_PORTS.forEach((p) => setupForward(p, p));
  });

  conn.on("error", (e) => {
    connecting = false;
    console.log("[ssh] Fehler: " + e.message);
    send("app:status", "SSH-Fehler: " + e.message);
  });

  conn.on("close", () => {
    ready = false;
    conn = null;
    send("app:status", "getrennt");
  });

  let privateKey;
  try {
    privateKey = fs.readFileSync(expandKeyPath(profile.keyPath));
  } catch (e) {
    connecting = false;
    send("app:status", "Key nicht lesbar: " + e.message);
    return;
  }

  send("app:status", "verbinde zu " + profile.username + "@" + profile.host + " ...");
  conn.connect({
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    privateKey,
    keepaliveInterval: 30000,
  });
}

function openChannel(id, cols, rows) {
  if (!conn || !ready) return;
  if (channels[id]) return; // schon offen
  conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
    if (err) {
      console.log("[ch " + id + "] Shell-Fehler: " + err.message);
      send("channel:status", { id, status: "Fehler: " + err.message });
      return;
    }
    channels[id] = stream;
    console.log("[ch " + id + "] offen " + cols + "x" + rows);
    if (STARTUP[id]) stream.write(STARTUP[id]);
    stream.on("data", (d) => send("channel:data", { id, data: d.toString("utf8") }));
    if (stream.stderr) {
      stream.stderr.on("data", (d) => send("channel:data", { id, data: d.toString("utf8") }));
    }
    stream.on("close", () => {
      delete channels[id];
      console.log("[ch " + id + "] geschlossen");
      send("channel:status", { id, status: "closed" });
    });
  });
}

app.whenReady().then(() => {
  // Rechtsklick-Kontextmenue + DevTools fuer die Browser-Zelle (webview)
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "webview") return;
    contents.on("devtools-opened", () => console.log("[devtools] webview geoeffnet"));
    contents.on("context-menu", (_ev, params) => {
      const ef = params.editFlags || {};
      const items = [
        { label: "Zurueck", enabled: contents.canGoBack(), click: () => contents.goBack() },
        { label: "Vor", enabled: contents.canGoForward(), click: () => contents.goForward() },
        { label: "Neu laden", click: () => contents.reload() },
        { type: "separator" },
        { label: "Kopieren", enabled: !!ef.canCopy, click: () => contents.copy() },
        { label: "Einfuegen", enabled: !!ef.canPaste, click: () => contents.paste() },
        { label: "Alles markieren", click: () => contents.selectAll() },
      ];
      if (params.linkURL) {
        items.push({ type: "separator" });
        items.push({ label: "Linkadresse kopieren", click: () => clipboard.writeText(params.linkURL) });
      }
      items.push({ type: "separator" });
      items.push({ label: "Untersuchen", click: () => contents.inspectElement(params.x, params.y) });
      items.push({ label: "DevTools", click: () => contents.openDevTools({ mode: "detach" }) });
      Menu.buildFromTemplate(items).popup();
    });
  });

  loadConnections();
  createWindow();

  // Test-/Steuer-Hook (nur mit DEVBOX_DEV=1): Datei "__ctl" -> shot|nav|toggle|devtools|ssh|switch
  if (process.env.DEVBOX_DEV) {
  const CTL = path.join(__dirname, "..", "__ctl");
  const SHOT = path.join(__dirname, "..", "shot.png");
  try { fs.writeFileSync(CTL, ""); } catch (_) {}
  fs.watchFile(CTL, { interval: 200 }, () => {
    let cmd = "";
    try { cmd = fs.readFileSync(CTL, "utf8").trim(); } catch (_) { return; }
    if (!cmd) return;
    if (cmd === "shot") {
      if (win) win.webContents.capturePage().then((img) => {
        try { fs.writeFileSync(SHOT, img.toPNG()); console.log("[ctl] shot gespeichert"); }
        catch (e) { console.log("[ctl] shot-Fehler " + e.message); }
      });
    } else if (cmd.indexOf("nav ") === 0) {
      send("ctl:nav", cmd.slice(4).trim());
      console.log("[ctl] nav " + cmd.slice(4).trim());
    } else if (cmd === "toggle") {
      send("ctl:toggle");
      console.log("[ctl] toggle");
    } else if (cmd === "devtools") {
      send("ctl:devtools");
      console.log("[ctl] devtools");
    } else if (cmd === "ssh") {
      send("ctl:ssh");
      console.log("[ctl] ssh");
    } else if (cmd === "switch") {
      const ids = connections.map((c) => c.id);
      if (ids.length) {
        const next = ids[(ids.indexOf(activeId) + 1) % ids.length];
        console.log("[ctl] switch -> " + next);
        activateConn(next);
      }
    }
  });
  }

  ipcMain.on("app:connect", () => connectSSH());

  // SSH-Verbindungsverwaltung
  ipcMain.handle("conn:list", () => ({ connections, activeId }));
  ipcMain.on("conn:save", (e, profile) => {
    if (!profile || !profile.host) return;
    if (profile.id) {
      const i = connections.findIndex((c) => c.id === profile.id);
      if (i >= 0) connections[i] = profile;
      else connections.push(profile);
    } else {
      profile.id = "c" + Date.now();
      connections.push(profile);
    }
    saveConnections();
    send("conn:changed");
  });
  ipcMain.on("conn:delete", (e, id) => {
    connections = connections.filter((c) => c.id !== id);
    if (activeId === id) activeId = connections[0] ? connections[0].id : null;
    saveConnections();
    send("conn:changed");
  });
  function activateConn(id) {
    if (!connections.find((c) => c.id === id)) return;
    activeId = id;
    saveConnections();
    teardown();
    send("app:reset");
    send("conn:changed");
    setTimeout(connectSSH, 200); // kurz warten bis alte Forward-Ports frei sind
  }
  ipcMain.on("conn:activate", (e, id) => activateConn(id));

  ipcMain.on("channel:open", (e, { id, cols, rows }) => openChannel(id, cols, rows));
  ipcMain.on("channel:input", (e, { id, data }) => {
    const s = channels[id];
    if (s) s.write(data);
  });
  ipcMain.on("channel:resize", (e, { id, cols, rows }) => {
    const s = channels[id];
    if (s) s.setWindow(rows, cols, 0, 0);
  });
  ipcMain.on("channel:close", (e, { id }) => {
    const s = channels[id];
    if (s) s.close();
  });

  ipcMain.handle("clipboard:read", () => clipboard.readText());
  ipcMain.on("clipboard:write", (e, text) => clipboard.writeText(text || ""));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  Object.values(channels).forEach((s) => {
    try {
      s.close();
    } catch (_) {}
  });
  if (conn) {
    try {
      conn.end();
    } catch (_) {}
  }
  app.quit();
});
