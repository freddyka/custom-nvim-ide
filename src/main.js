const { app, BrowserWindow, ipcMain, clipboard, Menu } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const { Client } = require("ssh2");

// userData bleibt %APPDATA%/devbox-app bzw. ~/.config/devbox-app, egal wie das Build-Produkt heisst.
app.setName("devbox-app");

// Standard-Verbindung. Ueberschreibbar per Umgebungsvariablen (DEVBOX_HOST/PORT/USER/KEY)
// oder im SSH-Manager der App. Die eigene Verbindung wird in connections.json gespeichert.
const CONN = {
  host: process.env.DEVBOX_HOST || "127.0.0.1",
  port: Number(process.env.DEVBOX_PORT || 22),
  username: process.env.DEVBOX_USER || os.userInfo().username,
  keyPath: process.env.DEVBOX_KEY || path.join(os.homedir(), ".ssh", "id_ed25519"),
};

// Programm je Zelle. Jede Zelle haengt an einer eigenen tmux-Session,
// deren Name von der aktiven App-Session abhaengt (siehe tmuxName).
const CELL_PROG = { edit: "nvim", shell: "", ai: "", shell2: "" };

// Dev-Ports, die lokal (Windows/127.0.0.1) auf den Laptop getunnelt werden.
const FORWARD_PORTS = [3000, 4173, 5173, 8000, 8080];

let win = null;
let conn = null;
let connecting = false;
let ready = false;
let intentionalClose = false; // true = wir trennen absichtlich (kein Auto-Reconnect)
let reconnectTimer = null;    // laufender Auto-Reconnect-Timer (idempotent)
let lostClient = null;        // Verbindung, deren Verlust bereits behandelt wurde (error+close)
let connectStartedAt = 0;     // Zeitpunkt des letzten Verbindungsversuchs (fuer Watchdog)
let watchdog = null;          // Reconnect-Watchdog-Timer

// Ein verirrter Fehler darf NICHT den Main-Prozess (und damit Reconnect-Timer) lahmlegen.
process.on("uncaughtException", (e) => console.log("[uncaught] " + ((e && e.stack) || e)));
process.on("unhandledRejection", (e) => console.log("[unhandledRejection] " + ((e && e.stack) || e)));
const channels = {}; // id -> ssh2 stream
let forwardServers = [];

// SSH-Verbindungsprofile (verwaltbar ueber den SSH-Button in der Leiste)
let connFile = null;
let connections = [];
let activeId = null;

// Benannte App-Sessions (verwaltbar ueber den Sessions-Button)
let sessFile = null;
let sessions = ["main"];
let activeSession = "main";

// tmux-Sessionname je Zelle, abhaengig von der aktiven App-Session.
// "main" nutzt die schlichten Namen (edit/shell/ai/shell2), andere bekommen ein Praefix.
function tmuxName(id) {
  return activeSession === "main" ? id : activeSession + "-" + id;
}
function startupCmd(id) {
  const name = tmuxName(id);
  const prog = CELL_PROG[id] || "";
  // Programm-Zellen fallen nach dem Beenden auf eine Shell zurueck, damit die tmux-Session
  // nie stirbt. edit bekommt DEVBOX_EDIT=1 -> nvim stellt die zuletzt offenen Dateien wieder her.
  let body = "";
  if (prog === "nvim") body = " 'export DEVBOX_EDIT=1; nvim; exec ${SHELL:-bash}'";
  else if (prog) body = " '" + prog + "; exec ${SHELL:-bash}'";
  return "clear; tmux new-session -A -s " + name + body + "\n";
}
function sanitizeSessionName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

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

function loadSessions() {
  sessFile = path.join(app.getPath("userData"), "sessions.json");
  try {
    const d = JSON.parse(fs.readFileSync(sessFile, "utf8"));
    if (Array.isArray(d.sessions) && d.sessions.length) sessions = d.sessions;
    if (d.active) activeSession = d.active;
  } catch (_) {}
  if (!sessions.length) sessions = ["main"];
  if (sessions.indexOf(activeSession) < 0) activeSession = sessions[0];
}
function saveSessionsFile() {
  try { fs.writeFileSync(sessFile, JSON.stringify({ sessions: sessions, active: activeSession }, null, 2)); } catch (_) {}
}
function activateSessionName(name) {
  if (sessions.indexOf(name) < 0) return;
  activeSession = name;
  saveSessionsFile();
  teardown();
  send("app:reset");
  send("session:changed");
  setTimeout(connectSSH, 200);
}
function tmuxSessionsOf(name) {
  return ["edit", "shell", "ai", "shell2"].map(function (id) {
    return name === "main" ? id : name + "-" + id;
  });
}
function teardown() {
  stopAutosave();
  Object.keys(channels).forEach((id) => { try { channels[id].close(); } catch (_) {} delete channels[id]; });
  forwardServers.forEach((s) => { try { s.close(); } catch (_) {} });
  forwardServers = [];
  intentionalClose = true; // absichtliche Trennung -> kein Auto-Reconnect
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } // geplanten Reconnect abbrechen
  if (conn) { try { conn.end(); } catch (_) {} }
  conn = null;
  ready = false;
  connecting = false;
}

// --- Autosave: regelmaessig + beim Schliessen die tmux/nvim-Session sichern ---
var saveTimer = null;
function saveSession(cb) {
  if (!conn || !ready) { if (cb) cb(); return; }
  conn.exec("tmux list-sessions >/dev/null 2>&1 && ~/.tmux/plugins/tmux-resurrect/scripts/save.sh quiet >/dev/null 2>&1; echo SAVED", function (err, stream) {
    if (err || !stream) { if (cb) cb(); return; }
    stream.on("data", function () {});
    if (stream.stderr) stream.stderr.on("data", function () {});
    stream.on("close", function () { if (cb) cb(); });
  });
}
function startAutosave() {
  stopAutosave();
  saveTimer = setInterval(function () { saveSession(); }, 120000); // alle 2 Minuten
}
function stopAutosave() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
}

function createWindow() {
  Menu.setApplicationMenu(null); // Standard-Menue weg: Strg++/-/0 (Zoom), Strg+R, Strg+W nicht abfangen
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
  let retries = 0;
  server.on("error", (e) => {
    // Port noch von einer alten Instanz belegt? Kurz warten und erneut binden.
    if (e.code === "EADDRINUSE" && retries < 15) {
      retries++;
      setTimeout(() => { if (!server.listening) { try { server.listen(localPort, "127.0.0.1"); } catch (_) {} } }, 1000);
      return;
    }
    console.log("[fwd] " + localPort + " Fehler: " + e.message);
  });
  server.listen(localPort, "127.0.0.1", () =>
    console.log("[fwd] localhost:" + localPort + " -> " + remotePort)
  );
  forwardServers.push(server);
}

function expandKeyPath(p) {
  if (p && p.indexOf("~") === 0) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Verbindung verloren: Zustand sauber zuruecksetzen und (sofern nicht absichtlich) neu verbinden.
// Wird von error UND close aufgerufen; pro Client nur einmal wirksam, Reconnect ist idempotent.
function loseConnection(client) {
  if (conn && conn !== client) return; // ein neuerer Connect hat bereits uebernommen
  if (lostClient === client) return;   // schon behandelt (error + close fuer denselben Client)
  lostClient = client;
  ready = false;
  connecting = false;
  conn = null;
  Object.keys(channels).forEach((id) => { delete channels[id]; }); // Streams sind tot
  forwardServers.forEach((s) => { try { s.close(); } catch (_) {} });
  forwardServers = [];
  if (intentionalClose) { intentionalClose = false; send("app:status", "getrennt"); return; }
  if (reconnectTimer) return; // Reconnect bereits geplant
  send("app:reset");
  send("app:status", "Verbindung verloren - neu verbinden ...");
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSSH(); }, 2000);
}

// Watchdog: faengt JEDEN haengenden/verlorenen Zustand ab, egal wie er entstand.
// Laeuft ab dem ersten Verbindungswunsch und stellt sicher, dass immer wieder verbunden wird.
function watchdogTick() {
  if (intentionalClose) return;                 // absichtlich getrennt
  if (ready && conn) return;                     // alles gut, verbunden
  if (reconnectTimer) return;                    // Reconnect bereits geplant
  if (connecting && Date.now() - connectStartedAt < 20000) return; // Versuch laeuft noch (max 20s)
  console.log("[watchdog] Verbindung nicht aktiv -> erzwinge Reconnect");
  if (conn) { try { conn.end(); } catch (_) {} } // evtl. haengenden Client wegraeumen
  conn = null;
  connecting = false;
  send("app:reset");
  connectSSH();
}
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(watchdogTick, 8000);
}

function connectSSH() {
  if (conn || connecting) return;
  const profile = activeProfile();
  connecting = true;
  connectStartedAt = Date.now();
  intentionalClose = false; // neuer Verbindungsversuch -> kuenftige Abbrueche sind unerwartet
  conn = new Client();
  const thisConn = conn; // gegen Races: spaetes close einer alten Verbindung ignorieren

  conn.on("ready", () => {
    ready = true;
    connecting = false;
    console.log("[ssh] verbunden mit " + profile.host);
    send("app:status", "verbunden: " + profile.name + " - lade Session ...");
    FORWARD_PORTS.forEach((p) => setupForward(p, p));
    // Nach einem Reboot laeuft evtl. kein tmux-Server. Einen Server zu starten loest
    // tmux-continuum/resurrect aus (Sessions samt Inhalt werden wiederhergestellt).
    // Erst danach die Zellen oeffnen, damit sie sich an die restorten Sessions haengen.
    var boot = "if ! tmux list-sessions 2>/dev/null | grep -q .; then " +
      "tmux new-session -d -s __boot 2>/dev/null; sleep 4; tmux kill-session -t __boot 2>/dev/null; " +
      "echo RESTORED; fi; echo BOOT_DONE";
    var bootDone = false;
    function finishBoot() {
      if (bootDone) return; // nur einmal: Zellen oeffnen + Autosave starten
      bootDone = true;
      send("app:status", "verbunden: " + profile.name);
      send("app:ready", true);
      startAutosave();
    }
    conn.exec(boot, function (err, stream) {
      if (err || !stream) { finishBoot(); return; }
      var out = "";
      stream.on("data", function (d) { out += d.toString(); });
      if (stream.stderr) stream.stderr.on("data", function () {});
      stream.on("close", function () {
        if (out.indexOf("RESTORED") >= 0) console.log("[boot] Session nach Reboot wiederhergestellt");
        finishBoot();
      });
    });
    setTimeout(finishBoot, 8000); // Sicherheitsnetz: Boot-Exec darf die Zellen nicht ewig blockieren
  });

  conn.on("error", (e) => {
    console.log("[ssh] Fehler: " + e.message);
    send("app:status", "SSH-Fehler: " + e.message);
    loseConnection(thisConn); // auch bei error neu planen (sonst Haenger ohne close)
  });

  conn.on("close", () => {
    loseConnection(thisConn);
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
    // Tolerant: ein langsamer/ausgelasteter Laptop darf ein paar Keepalives verschlucken,
    // ohne dass ssh2 die Verbindung selbst kappt. ~2 Min bis ein wirklich toter Link erkannt
    // wird; die schnelle Erholung uebernimmt ohnehin der Watchdog/Reconnect.
    keepaliveInterval: 20000,
    keepaliveCountMax: 6,
    readyTimeout: 20000, // haengender Verbindungsversuch scheitert -> Reconnect statt Haenger
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
    console.log("[ch " + id + "] offen " + cols + "x" + rows + " (" + tmuxName(id) + ")");
    stream.write(startupCmd(id));
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

// Nur eine Instanz erlauben: ein zweiter Start fokussiert das vorhandene Fenster,
// statt eine zweite App zu oeffnen (die sich an den Port-Forwards verschlucken wuerde).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createWindow(); // Fenster war zu (z.B. waehrend des Schliessens) -> neu oeffnen statt Absturz
    }
  });
  app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.freddyka.devbox");

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
  loadSessions();
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
    } else if (cmd === "sess") {
      send("ctl:sess");
      console.log("[ctl] sess");
    } else if (cmd.indexOf("sessnew ") === 0) {
      const n = sanitizeSessionName(cmd.slice(8));
      if (n && sessions.indexOf(n) < 0) {
        sessions.push(n); saveSessionsFile(); send("session:changed");
        console.log("[ctl] sessnew " + n);
        activateSessionName(n);
      }
    } else if (cmd.indexOf("sessto ") === 0) {
      console.log("[ctl] sessto " + cmd.slice(7).trim());
      activateSessionName(cmd.slice(7).trim());
    }
  });
  }

  ipcMain.on("app:connect", () => { startWatchdog(); connectSSH(); });

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

  // App-Session-Verwaltung (mehrere benannte Sessions)
  function runExec(cmd) {
    if (!conn || !ready) return;
    conn.exec(cmd, (err, st) => {
      if (!st) return;
      st.on("data", () => {});
      if (st.stderr) st.stderr.on("data", () => {});
      st.on("close", () => {});
    });
  }
  ipcMain.handle("session:list", () => ({ sessions: sessions, active: activeSession }));
  ipcMain.on("session:create", (e, rawName) => {
    const name = sanitizeSessionName(rawName);
    if (!name || sessions.indexOf(name) >= 0) return;
    sessions.push(name);
    saveSessionsFile();
    send("session:changed");
    activateSessionName(name);
  });
  ipcMain.on("session:rename", (e, payload) => {
    const from = payload && payload.from;
    const to = sanitizeSessionName(payload && payload.to);
    const i = sessions.indexOf(from);
    if (i < 0 || !to || sessions.indexOf(to) >= 0) return;
    const olds = tmuxSessionsOf(from), news = tmuxSessionsOf(to);
    let cmd = "";
    for (let k = 0; k < olds.length; k++) cmd += "tmux rename-session -t " + olds[k] + " " + news[k] + " 2>/dev/null; ";
    runExec(cmd);
    sessions[i] = to;
    if (activeSession === from) activeSession = to;
    saveSessionsFile();
    send("session:changed");
  });
  ipcMain.on("session:delete", (e, name) => {
    if (sessions.length <= 1 || sessions.indexOf(name) < 0) return;
    runExec(tmuxSessionsOf(name).map((n) => "tmux kill-session -t " + n + " 2>/dev/null").join("; "));
    const wasActive = activeSession === name;
    sessions = sessions.filter((s) => s !== name);
    if (wasActive) activeSession = sessions[0];
    saveSessionsFile();
    send("session:changed");
    if (wasActive) activateSessionName(activeSession);
  });
  ipcMain.on("session:activate", (e, name) => activateSessionName(name));

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

  // Rechtsklick-Menue (Kopieren/Einfuegen) fuer die Terminal-Zellen
  ipcMain.on("term:menu", (e, { id, hasSelection }) => {
    Menu.buildFromTemplate([
      { label: "Kopieren", enabled: !!hasSelection, click: () => send("term:copy", id) },
      { label: "Einfuegen", click: () => send("term:paste", id) },
      { type: "separator" },
      { label: "Alles markieren", click: () => send("term:selectall", id) },
    ]).popup();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  });
} // Ende Single-Instance-Lock

app.on("window-all-closed", () => {
  // Beim Schliessen nochmal sichern, damit der letzte Stand erhalten bleibt.
  intentionalClose = true; // App wird beendet -> kein Auto-Reconnect
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  forwardServers.forEach((s) => { try { s.close(); } catch (_) {} }); // Ports sofort freigeben
  forwardServers = [];
  stopAutosave();
  saveSession(function () {
    Object.values(channels).forEach((s) => {
      try { s.close(); } catch (_) {}
    });
    if (conn) {
      try { conn.end(); } catch (_) {}
    }
    app.quit();
  });
  // Sicherheitsnetz: falls Save haengt, trotzdem nach 3s beenden.
  setTimeout(function () { try { app.quit(); } catch (_) {} }, 3000);
});
