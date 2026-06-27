const THEME = {
  background: "#181825", foreground: "#cdd6f4", cursor: "#cdd6f4", selectionBackground: "#45475a",
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa",
  magenta: "#cba6f7", cyan: "#94e2d5", white: "#bac2de", brightBlack: "#585b70", brightRed: "#f38ba8",
  brightGreen: "#a6e3a1", brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5", brightWhite: "#a6adc8",
};
const FONT = '"JetBrainsMono NFM", "JetBrains Mono", Consolas, monospace';

// id -> elementId der Terminal-Zelle (und tmux-Sessionname)
const TERM_EL = { edit: "term-edit", shell: "term-shell", ai: "term-ai", shell2: "term-shell2" };
// Zellen-Position -> Channel (fuer Fokus per Tastatur)
const CELL_OF = { 1: "edit", 2: "shell", 3: "tr", 4: "ai" };

const cells = {}; // id -> { t, fit, inputDisp, opened }
const lastSel = {}; // pro Zelle: Auswahl im Moment des Rechtsklicks (bevor xterm sie loescht)
let brOn = true;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} },
};

function ensureCell(id) {
  if (cells[id]) return cells[id];
  const fs0 = Number(LS.get("db_font_" + id)) || 13;
  const t = new Terminal({
    fontFamily: FONT, fontSize: fs0, cursorBlink: true, allowProposedApi: true, scrollback: 5000, theme: THEME,
  });
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  t.open(document.getElementById(TERM_EL[id]));

  t.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
      const sel = t.getSelection();
      if (sel) window.devbox.clipboardWrite(sel);
      return false;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
      window.devbox.clipboardRead().then((txt) => { if (txt) window.devbox.input(id, txt); });
      return false;
    }
    // Schriftgroesse: Strg++ groesser, Strg+- kleiner, Strg+0 zuruecksetzen
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setFont(id, (t.options.fontSize || 13) + 1); return false; }
      if (e.key === "-") { e.preventDefault(); setFont(id, (t.options.fontSize || 13) - 1); return false; }
      if (e.key === "0") { e.preventDefault(); setFont(id, 13); return false; }
    }
    return true;
  });

  const el = document.getElementById(TERM_EL[id]);
  el.addEventListener("mousedown", (e) => {
    if (e.button === 1) { // Mittelklick = einfuegen
      e.preventDefault();
      window.devbox.clipboardRead().then((txt) => { if (txt) window.devbox.input(id, txt); });
    }
  });
  // Rechtsklick: Auswahl sichern UND xterm-Handler stoppen, damit die Markierung sichtbar bleibt
  el.addEventListener("mousedown", (e) => {
    if (e.button === 2) { lastSel[id] = t.getSelection(); e.stopPropagation(); }
  }, true);
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // Rechtsklick -> eigenes Kopieren/Einfuegen-Menue
    window.devbox.termMenu(id, !!lastSel[id]);
  });
  // Strg+Mausrad: Schrift in dieser Zelle zoomen
  el.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setFont(id, (t.options.fontSize || 13) + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  const c = { t, fit, inputDisp: null, opened: false };
  c.inputDisp = t.onData((d) => window.devbox.input(id, d));
  cells[id] = c;
  return c;
}

function fitCell(id) {
  const c = cells[id];
  if (!c) return;
  try { c.fit.fit(); } catch (_) {}
  if (c.opened && c.t.cols && c.t.rows && (c._cols !== c.t.cols || c._rows !== c.t.rows)) {
    c._cols = c.t.cols;
    c._rows = c.t.rows;
    window.devbox.resize(id, c.t.cols, c.t.rows);
  }
}

function setFont(id, px) {
  const c = cells[id];
  if (!c) return;
  px = Math.max(7, Math.min(28, Math.round(px)));
  if (c.t.options.fontSize === px) return;
  c.t.options.fontSize = px;
  LS.set("db_font_" + id, px);
  fitCell(id);
}

function openCell(id) {
  const c = ensureCell(id);
  try { c.fit.fit(); } catch (_) {}
  if (!c.opened) {
    c.opened = true;
    window.devbox.openChannel(id, c.t.cols || 80, c.t.rows || 24);
  }
}

// --- Layout merken / wiederherstellen ---
function saveLayout() {
  LS.set("db_colL", Math.round(document.getElementById("colL").getBoundingClientRect().width));
  LS.set("db_topL", Math.round(document.getElementById("cell-edit").getBoundingClientRect().height));
  LS.set("db_topR", Math.round(document.getElementById("cell-tr").getBoundingClientRect().height));
  LS.set("db_browser", brOn ? "1" : "0");
}
function restoreLayout() {
  const colL = LS.get("db_colL", null);
  if (colL) document.getElementById("colL").style.flex = "0 0 " + colL + "px";
  const tl = LS.get("db_topL", null);
  if (tl) document.getElementById("cell-edit").style.flex = "0 0 " + tl + "px";
  const tr = LS.get("db_topR", null);
  if (tr) document.getElementById("cell-tr").style.flex = "0 0 " + tr + "px";
}

// --- Aktive Zelle ---
function setActiveEl(cellEl) {
  document.querySelectorAll(".cell").forEach((c) => c.classList.remove("active"));
  if (cellEl) cellEl.classList.add("active");
}
document.querySelectorAll(".cell").forEach((cell) => {
  cell.addEventListener("focusin", () => setActiveEl(cell));
  cell.addEventListener("mousedown", () => setActiveEl(cell));
});

function focusCell(pos) {
  const id = CELL_OF[pos];
  if (id === "tr") {
    setActiveEl(document.getElementById("cell-tr"));
    if (brOn) document.getElementById("url").focus();
    else { ensureCell("shell2"); cells.shell2.t.focus(); }
  } else {
    setActiveEl(document.getElementById("cell-" + id));
    if (cells[id]) cells[id].t.focus();
  }
}

// --- SSH / Kanaele ---
const statusEl = document.getElementById("status");
window.devbox.onAppStatus((s) => { statusEl.textContent = s || ""; });
window.devbox.onData((p) => { const c = cells[p.id]; if (c) c.t.write(p.data); });

window.devbox.onTermCopy((id) => { const s = lastSel[id]; if (s) window.devbox.clipboardWrite(s); });
window.devbox.onTermPaste((id) => { window.devbox.clipboardRead().then((txt) => { if (txt) window.devbox.input(id, txt); }); });
window.devbox.onTermSelectAll((id) => { const c = cells[id]; if (c) c.t.selectAll(); });

window.devbox.onChannelStatus((p) => {
  const c = cells[p.id];
  if (p.status === "closed" && c) {
    c.opened = false;
    if (c.inputDisp) c.inputDisp.dispose();
    c.t.write("\r\n\x1b[90m[Sitzung beendet — Enter zum Neustart]\x1b[0m\r\n");
    const one = c.t.onData((d) => {
      if (d === "\r" || d === "\n") {
        one.dispose();
        c.t.reset();
        c.inputDisp = c.t.onData((x) => window.devbox.input(p.id, x));
        openCell(p.id);
      }
    });
  }
});

window.devbox.onReady(() => {
  openCell("edit");
  openCell("shell");
  openCell("ai");
  if (!brOn) openCell("shell2");
  setActiveEl(document.getElementById("cell-edit"));
  cells.edit.t.focus();
});

// --- Browser-Zelle ---
const trBrowser = document.getElementById("tr-browser");
const trTerm = document.getElementById("tr-term");
const toggleBtn = document.getElementById("toggleBrowser");

function applyBrowserVisibility(on) {
  trBrowser.style.display = on ? "flex" : "none";
  trTerm.style.display = on ? "none" : "flex";
  toggleBtn.textContent = on ? "browser an" : "browser aus";
  toggleBtn.classList.toggle("on", on);
}
function setBrowser(on) {
  brOn = on;
  applyBrowserVisibility(on);
  if (!on) {
    openCell("shell2");
    requestAnimationFrame(() => { fitCell("shell2"); if (cells.shell2) cells.shell2.t.focus(); });
  }
  saveLayout();
}
toggleBtn.addEventListener("click", () => setBrowser(!brOn));
document.getElementById("b-toterm").addEventListener("click", () => setBrowser(false));
document.getElementById("b-tobrowser").addEventListener("click", () => setBrowser(true));

// --- Webview ---
const wv = document.getElementById("wv");
const url = document.getElementById("url");
function navigate() {
  let u = url.value.trim();
  if (!u) return;
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  url.value = u;
  try { wv.loadURL(u); } catch (_) { wv.src = u; }
}
url.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(); });
document.getElementById("b-back").addEventListener("click", () => { try { if (wv.canGoBack()) wv.goBack(); } catch (_) {} });
document.getElementById("b-fwd").addEventListener("click", () => { try { if (wv.canGoForward()) wv.goForward(); } catch (_) {} });
document.getElementById("b-reload").addEventListener("click", () => { try { wv.reload(); } catch (_) {} });
wv.addEventListener("did-navigate", (e) => { if (e.url && e.url !== "about:blank") url.value = e.url; });

function toggleDevtools() {
  try { wv.isDevToolsOpened() ? wv.closeDevTools() : wv.openDevTools(); } catch (_) {}
}
document.getElementById("b-devtools").addEventListener("click", toggleDevtools);

// Test-Steuerung
window.devbox.onCtlNav((u) => { if (!brOn) setBrowser(true); url.value = u; navigate(); });
window.devbox.onCtlToggle(() => setBrowser(!brOn));
window.devbox.onCtlDevtools(() => toggleDevtools());

// --- Splitter (unabhaengig links/rechts) ---
const grid = document.getElementById("grid");

let refitScheduled = false;
function scheduleRefit() {
  if (refitScheduled) return;
  refitScheduled = true;
  requestAnimationFrame(() => { refitScheduled = false; refitAll(); });
}

function startDrag(mv, up) {
  document.body.classList.add("dragging"); // Pointer-Events von Webview/Terminals aus
  const onMove = (ev) => mv(ev);
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("dragging");
    refitAll();
    saveLayout();
    if (up) up();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function dragV(handle, target) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = target.getBoundingClientRect().width;
    const max = grid.getBoundingClientRect().width - 200;
    startDrag((ev) => {
      target.style.flex = "0 0 " + Math.max(200, Math.min(max, startW + ev.clientX - startX)) + "px";
      scheduleRefit();
    });
  });
}
function dragH(handle) {
  const top = document.getElementById(handle.dataset.target);
  const col = top.parentElement;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = top.getBoundingClientRect().height;
    const max = col.getBoundingClientRect().height - 70;
    startDrag((ev) => {
      top.style.flex = "0 0 " + Math.max(70, Math.min(max, startH + ev.clientY - startY)) + "px";
      scheduleRefit();
    });
  });
}
dragV(document.getElementById("vsplit"), document.getElementById("colL"));
document.querySelectorAll(".hsplit").forEach(dragH);

function refitAll() {
  ["edit", "shell", "ai"].forEach(fitCell);
  if (!brOn) fitCell("shell2");
}
let rt = null;
window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(refitAll, 60); });

// --- Globale Tastatur: Alt+1..4 Fokus, Alt+B Browser ---
window.addEventListener("keydown", (e) => {
  if (e.key === "F12") { toggleDevtools(); e.preventDefault(); e.stopPropagation(); return; }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
    if (e.key >= "1" && e.key <= "4") { focusCell(Number(e.key)); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === "b" || e.key === "B") { setBrowser(!brOn); e.preventDefault(); e.stopPropagation(); }
  }
}, true);

// --- SSH-Verbindungsmanager ---
const sshModal = document.getElementById("sshModal");
const connListEl = document.getElementById("connList");
const connForm = document.getElementById("connForm");
function fval(id) { return document.getElementById(id).value.trim(); }
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function showSsh() { sshModal.style.display = "flex"; connForm.style.display = "none"; renderConns(); }
function hideSsh() { sshModal.style.display = "none"; }
document.getElementById("sshBtn").addEventListener("click", showSsh);
document.getElementById("sshClose").addEventListener("click", hideSsh);
sshModal.addEventListener("mousedown", (e) => { if (e.target === sshModal) hideSsh(); });

async function renderConns() {
  const { connections, activeId } = await window.devbox.connList();
  connListEl.innerHTML = "";
  connections.forEach((c) => {
    const active = c.id === activeId;
    const row = document.createElement("div");
    row.className = "conn-row" + (active ? " active" : "");
    const info = document.createElement("div");
    info.innerHTML =
      '<div class="conn-name">' + escHtml(c.name || c.host) + (active ? '<span class="badge">aktiv</span>' : "") + "</div>" +
      '<div class="conn-sub">' + escHtml(c.username) + "@" + escHtml(c.host) + ":" + (c.port || 22) + "</div>";
    const btns = document.createElement("div");
    btns.className = "conn-btns";
    const bConn = document.createElement("button");
    bConn.textContent = active ? "verbunden" : "verbinden";
    bConn.disabled = active;
    bConn.addEventListener("click", () => { window.devbox.connActivate(c.id); hideSsh(); });
    const bEdit = document.createElement("button");
    bEdit.textContent = "bearbeiten";
    bEdit.addEventListener("click", () => editConn(c));
    btns.append(bConn, bEdit);
    if (connections.length > 1) {
      const bDel = document.createElement("button");
      bDel.textContent = "loeschen";
      bDel.addEventListener("click", () => { if (confirm("Verbindung loeschen: " + (c.name || c.host) + "?")) window.devbox.connDelete(c.id); });
      btns.append(bDel);
    }
    row.append(info, btns);
    connListEl.appendChild(row);
  });
}

function editConn(c) {
  connForm.style.display = "block";
  document.getElementById("f-id").value = c ? c.id : "";
  document.getElementById("f-name").value = c ? c.name || "" : "";
  document.getElementById("f-host").value = c ? c.host : "";
  document.getElementById("f-port").value = c ? c.port || 22 : 22;
  document.getElementById("f-user").value = c ? c.username : "";
  document.getElementById("f-key").value = c ? c.keyPath : "~/.ssh/id_ed25519";
}
document.getElementById("addConn").addEventListener("click", () => editConn(null));
document.getElementById("f-cancel").addEventListener("click", () => { connForm.style.display = "none"; });
document.getElementById("f-save").addEventListener("click", () => {
  const host = fval("f-host"), user = fval("f-user"), key = fval("f-key");
  if (!host || !user || !key) { alert("Host, Benutzer und Key-Pfad sind noetig."); return; }
  const profile = { id: fval("f-id") || undefined, name: fval("f-name") || host, host, port: Number(fval("f-port")) || 22, username: user, keyPath: key };
  window.devbox.connSave(profile);
  connForm.style.display = "none";
});

window.devbox.onConnChanged(() => { if (sshModal.style.display !== "none") renderConns(); });
window.devbox.onCtlSsh(() => showSsh());

// --- Session-Manager (mehrere benannte Sessions) ---
const sessModal = document.getElementById("sessModal");
const sessListEl = document.getElementById("sessList");
const sessForm = document.getElementById("sessForm");
const sessNameEl = document.getElementById("sessName");

function showSess() { sessModal.style.display = "flex"; sessForm.style.display = "none"; renderSessions(); }
function hideSess() { sessModal.style.display = "none"; }
document.getElementById("sessBtn").addEventListener("click", showSess);
document.getElementById("sessClose").addEventListener("click", hideSess);
sessModal.addEventListener("mousedown", (e) => { if (e.target === sessModal) hideSess(); });

async function renderSessions() {
  const { sessions, active } = await window.devbox.sessionList();
  sessNameEl.textContent = active;
  sessListEl.innerHTML = "";
  sessions.forEach((name) => {
    const isActive = name === active;
    const row = document.createElement("div");
    row.className = "conn-row" + (isActive ? " active" : "");
    const info = document.createElement("div");
    info.innerHTML = '<div class="conn-name">' + escHtml(name) + (isActive ? '<span class="badge">aktiv</span>' : "") + "</div>";
    const btns = document.createElement("div");
    btns.className = "conn-btns";
    const bOpen = document.createElement("button");
    bOpen.textContent = isActive ? "offen" : "oeffnen";
    bOpen.disabled = isActive;
    bOpen.addEventListener("click", () => { window.devbox.sessionActivate(name); hideSess(); });
    const bRen = document.createElement("button");
    bRen.textContent = "umbenennen";
    bRen.addEventListener("click", () => editSession(name));
    btns.append(bOpen, bRen);
    if (sessions.length > 1) {
      const bDel = document.createElement("button");
      bDel.textContent = "loeschen";
      bDel.addEventListener("click", () => { if (confirm("Session loeschen: " + name + "?  (Die Terminals dieser Session werden beendet)")) window.devbox.sessionDelete(name); });
      btns.append(bDel);
    }
    row.append(info, btns);
    sessListEl.appendChild(row);
  });
}

function editSession(oldName) {
  sessForm.style.display = "block";
  document.getElementById("sf-old").value = oldName || "";
  document.getElementById("sf-label").textContent = oldName ? "Session umbenennen (" + oldName + ")" : "Name der neuen Session";
  const inp = document.getElementById("sf-name");
  inp.value = oldName || "";
  inp.focus();
}
document.getElementById("addSess").addEventListener("click", () => editSession(null));
document.getElementById("sf-cancel").addEventListener("click", () => { sessForm.style.display = "none"; });
document.getElementById("sf-save").addEventListener("click", () => {
  const oldName = document.getElementById("sf-old").value;
  const name = document.getElementById("sf-name").value.trim();
  if (!name) { alert("Name noetig."); return; }
  if (oldName) window.devbox.sessionRename(oldName, name);
  else window.devbox.sessionCreate(name);
  sessForm.style.display = "none";
  hideSess();
});
document.getElementById("sf-name").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("sf-save").click(); });

function refreshSessName() {
  window.devbox.sessionList().then(({ active }) => { sessNameEl.textContent = active; });
}
window.devbox.onSessionChanged(() => {
  refreshSessName();
  if (sessModal.style.display !== "none") renderSessions();
});
window.devbox.onCtlSess(() => showSess());
refreshSessName();
window.devbox.onReset(() => {
  Object.values(cells).forEach((c) => { c.opened = false; try { c.t.reset(); } catch (_) {} });
});

// --- Start ---
restoreLayout();
brOn = LS.get("db_browser", "1") === "1";
applyBrowserVisibility(brOn);
ensureCell("edit");
ensureCell("shell");
ensureCell("ai");
window.devbox.connect();
