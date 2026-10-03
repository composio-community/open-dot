// Open Dot desktop shell. Runs the Next.js standalone server as a background process (Electron's own Node,
// so nothing else needs installing) and shows it in a window. Closing the window keeps the server running,
// so dots keep working and routines keep firing while the PC is awake; quit from the menu/tray.

import { app, BrowserWindow, shell, session, dialog, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

// Fixed, because Composio's sign-in redirects back to this address.
const PORT = Number(process.env.OPEN_DOT_PORT || 3100);
// Development: point the window at `pnpm dev` instead of starting the bundled server.
const DEV_URL = process.env.OPEN_DOT_DEV_URL || (process.argv.includes("--dev") ? "http://localhost:3100" : undefined);
const APP_URL = DEV_URL || `http://localhost:${PORT}`;
const isOurs = (url) => {
  try {
    const u = new URL(url);
    return u.origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
};

let server = null;
let win = null;
let quitting = false;
let tray = null;
const instance = crypto.randomUUID();
// Optional portable/test profile; normal launches keep Electron's standard per-user app data location.
if (process.env.OPEN_DOT_USER_DATA_DIR) app.setPath("userData", process.env.OPEN_DOT_USER_DATA_DIR);
if (process.platform === "win32") app.setAppUserModelId("dev.composio.opendot");

function checkPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${PORT} is already in use. Close the other application and reopen Open Dot.`)));
    probe.listen(PORT, "127.0.0.1", () => probe.close(resolve));
  });
}

function reopen() {
  if (!win) createWindow().loadURL(APP_URL);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (process.platform !== "win32") return;
  const icon = nativeImage.createFromPath(path.join(import.meta.dirname, "icon.png")).resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip("Open Dot — dots keep working while this PC is awake");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Open Dot", click: reopen },
    { type: "separator" },
    { label: "Quit Open Dot", click: () => app.quit() },
  ]));
  tray.on("double-click", reopen);
}

// Apps opened from Finder get a bare PATH; dots need the user's tools (git, docker, python, brew…).
function loginPath() {
  if (process.platform !== "darwin") return process.env.PATH || "";
  try {
    const shellPath = process.env.SHELL || "/bin/zsh";
    return execFileSync(shellPath, ["-ilc", "printf %s \"$PATH\""], { timeout: 5000, encoding: "utf8" }).trim();
  } catch {
    return ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":");
  }
}

function startServer() {
  const dir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(import.meta.dirname, "..", ".desktop", "server");
  if (!fs.existsSync(path.join(dir, "server.js"))) {
    dialog.showErrorBox("Open Dot", `The app server is missing (${dir}). Run \`pnpm desktop:prepare\` first.`);
    throw new Error("The bundled app server is missing.");
  }
  const dataDir = path.join(app.getPath("userData"), "data");
  const log = fs.createWriteStream(path.join(app.getPath("userData"), "server.log"), { flags: "a" });
  server = spawn(process.execPath, [path.join(dir, "server.js")], {
    windowsHide: true,
    cwd: dir,
    env: {
      ...process.env,
      PATH: loginPath(),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      DOTS_DATA_DIR: dataDir,
      DOTS_PUBLIC_URL: `http://localhost:${PORT}`,
      DOTS_DESKTOP_INSTANCE: instance,
      PLAYWRIGHT_BROWSERS_PATH: app.isPackaged ? path.join(process.resourcesPath, "browser") : path.join(import.meta.dirname, "..", ".desktop", "browser"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on("error", () => {
    dialog.showErrorBox("Open Dot", "Could not start the bundled app server. Check server.log in the app data folder.");
    app.quit();
  });
  server.on("exit", (code) => {
    server = null;
    if (quitting) return;
    dialog.showErrorBox("Open Dot", `The app server stopped (code ${code}). Details are in ${path.join(app.getPath("userData"), "server.log")}.`);
    app.quit();
  });
}

function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (!DEV_URL && (!server || server.exitCode !== null)) return reject(new Error("The app server stopped before startup completed."));
      const retry = () => Date.now() - started > timeoutMs ? reject(new Error("The app server didn't start.")) : setTimeout(tick, 250);
      const req = http.get(`${APP_URL}${DEV_URL ? "/globe.svg" : "/api/desktop/health"}`, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => res.statusCode === 200 && (DEV_URL || body === instance) ? resolve() : retry());
      });
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

const LOADING = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#f6f6f6;font-family:-apple-system,system-ui,sans-serif;color:#0a0a0a}
  body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px}
  .dots{display:flex}.dots span{width:18px;height:18px;border-radius:50%;margin-left:-5px;box-shadow:0 0 0 3px #f6f6f6;animation:b 1.2s ease-in-out infinite}
  .dots span:nth-child(1){background:#0a0a0a}.dots span:nth-child(2){background:#51a2ff;animation-delay:.15s}.dots span:nth-child(3){background:#c8f169;animation-delay:.3s}
  @keyframes b{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
  p{margin:0;font-size:13px;color:#0a0a0a8c}
</style></head><body><div class="dots"><span></span><span></span><span></span></div><p>Starting Open Dot…</p></body></html>`)}`;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    title: "Open Dot",
    backgroundColor: "#f6f6f6",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());

  // Links and sign-ins open in the default browser, never in an Electron window. The app opens Composio sign-in
  // as a blank popup and points it at the real URL a moment later, so that popup is kept hidden and its first
  // real address is handed to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank") return { action: "allow", overrideBrowserWindowOptions: { show: false } };
    if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => {
    const forward = (e, maybeUrl) => {
      const url = typeof maybeUrl === "string" ? maybeUrl : e?.url;
      if (!url || !/^https?:/.test(url)) return;
      void shell.openExternal(url);
      if (!child.isDestroyed()) child.destroy();
    };
    child.webContents.on("will-navigate", forward);
    child.webContents.on("did-start-navigation", forward);
    // Nothing to hand off (the app closed the popup, or it never got a URL): don't leave a hidden window behind.
    setTimeout(() => !child.isDestroyed() && child.destroy(), 30_000);
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isOurs(url) || url === LOADING) return;
    e.preventDefault();
    if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url);
  });

  // Keep the server running on close. The Windows tray provides explicit reopen/quit actions.
  win.on("close", (e) => {
    if ((process.platform === "darwin" || tray) && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => (win = null));
  return win;
}

// Microphone (voice mode), notifications and clipboard, for our own pages only.
const ALLOWED = new Set(["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
function setPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(ALLOWED.has(permission) && isOurs(details.requestingUrl || "")),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && isOurs(origin || ""));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", reopen);

  app.whenReady().then(async () => {
    setPermissions();
    createTray();
    createWindow();
    await win.loadURL(LOADING);
    try {
      if (!DEV_URL) { await checkPort(); startServer(); }
      await waitForServer();
      await win.loadURL(APP_URL);
    } catch (err) {
      // A navigation can replace the startup page before loadURL finishes.
      if (err.code === "ERR_ABORTED" || err.errno === -3 || (err.message && err.message.includes("ERR_ABORTED")) || quitting) return;
      dialog.showErrorBox("Open Dot", `${err.message}\n\nDetails are in ${path.join(app.getPath("userData"), "server.log")}.`);
      app.quit();
    }
  });

  app.on("activate", reopen);

  app.on("before-quit", () => {
    quitting = true;
    if (server) {
      if (process.platform === "win32") {
        // Windows SIGTERM only kills Node itself. Kill our owned tree, including dot browsers/commands.
        try { execFileSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); }
        catch { server.kill(); }
      } else server.kill("SIGTERM");
    }
    tray?.destroy();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !tray) app.quit();
  });
}
