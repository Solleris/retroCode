import { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell, Menu } from "electron";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DaemonLink } from "./daemon-link.ts";

/*
 * Identity, before anything else.
 *
 * `app.name` feeds the application menu's label, the About panel and the
 * userData path — and Electron reads it from package.json (productName takes
 * precedence over name). setName here is belt AND braces: if the app is ever
 * packaged with a different package.json, the name stays right.
 *
 * It has to run at top level, before ready: after that userData is already
 * resolved and changing the name would leave half the paths on the old one.
 */
app.setName("retroCode");

/*
 * An inspection port on demand: `RETRO_DEBUG_PORT=9222 bun run app`.
 *
 * It exists because checking UI by reading object properties has let pixel bugs
 * through more than once here — what counts is measuring what the screen shows.
 * With the port, `scripts/cdp.mjs` evaluates JS in the real renderer. Without
 * the env var nothing changes: an app that listens on a debug port by default
 * is an open door.
 */
const dbgPort = process.env["RETRO_DEBUG_PORT"];
if (dbgPort) app.commandLine.appendSwitch("remote-debugging-port", dbgPort);

const link = new DaemonLink();
let win: BrowserWindow | null = null;

/**
 * The icon path, dev and packaged.
 *
 * In dev the bundle is node_modules' Electron.app, whose icon is generic —
 * `dock.setIcon` overrides it at runtime. Packaged, the bundle's own .icns
 * already wins, and this becomes harmless redundancy.
 */
function iconPath(): string | null {
  const cands = [
    join(import.meta.dirname, "../../assets/icon.png"),        // dev
    join(process.resourcesPath, "assets/icon.png"),            // empacotado
  ];
  return cands.find((p) => existsSync(p)) ?? null;
}

/*
 * The main process has its own handful of strings (menu, folder dialog) and
 * CANNOT import the renderer's i18n: there the language comes from
 * localStorage, which does not exist here. The source here is
 * `app.getLocale()`, the system language.
 *
 * The honest consequence: if you change the WINDOW's language from the
 * palette, the macOS menu stays in the system language. An app menu on macOS
 * belongs to the system, not to the document — and a menu in one language
 * inside a menu bar in another would be worse.
 */
const ptBR = (): boolean => app.getLocale().toLowerCase().startsWith("pt");
const L = (pt: string, en: string): string => (ptBR() ? pt : en);

/**
 * An explicit application menu.
 *
 * Not merely cosmetic: Electron's default menu has a "File" whose only item is
 * `Close Window [⌘W]`, and a menu accelerator fires BEFORE the renderer's
 * keydown. So ⌘W closed the ENTIRE WINDOW instead of the focused pane — in a
 * pane-based app that is destructive and invisible: you lose every terminal at
 * once with no way to know why. There is no File menu here, so ⌘W reaches the
 * renderer; closing the window became ⇧⌘W.
 */
function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: L("Janela", "Window"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "close", accelerator: "Shift+Cmd+W", label: L("Fechar janela", "Close window") },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ]));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // No title chrome: the traffic lights sit inset and the app's own status
    // bar takes that space. Visual decision number one.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    // Fixed dark. An IDE that changes theme by the system clock swaps the
    // contrast of the code under you in the middle of a review.
    backgroundColor: "#0B0E12",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  /**
   * EVERY external navigation goes to the SYSTEM browser.
   *
   * Without this, Electron opens links in a BrowserWindow of its own — which
   * has a separate cookie jar, so GitHub shows up logged out. It is not
   * "another tab": it is another browser, empty, inside the app. The user wants
   * their own browser, where the session exists.
   *
   * Protocol allowlist: `openExternal` hands the URL to the system, so a
   * `file://` or `smb://` coming from some repo's markdown would be an open
   * door. Only http/https pass.
   */
  const openExternally = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      void shell.openExternal(url);
      return true;
    } catch { return false; }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };          // never open an Electron window
  });

  win.webContents.on("will-navigate", (e, url) => {
    // The app is a local SPA: any navigation outward is a link, not a route.
    if (url.startsWith("file://") || url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\u0000")) return;
    e.preventDefault();
    openExternally(url);
  });

  ipcMain.handle("shell:openExternal", (_e, url: string) => openExternally(url));

  // Without this, an error in the renderer is absolute silence: no stdout, no
  // log, no hint. Forwarding the console is the difference between debugging
  // and guessing.
  win.webContents.on("console-message", (e) => {
    const tag = e.level === "error" ? "ERRO" : e.level === "warning" ? "WARN" : "log";
    console.log(`[renderer ${tag}] ${e.message}  (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on("render-process-gone", (_e, d) =>
    console.log(`[renderer MORREU] ${d.reason} exit=${d.exitCode}`));

  // The project root arrives via query string. The renderer has no Node, and
  // hardcoding a path in a UI file is the start of an annoying debt.
  // argv[1] allows `retroCode . /path/to/project` later on.
  const argRoot = process.argv.slice(1).find((a) => a.startsWith("/") && existsSync(a));
  /*
   * The fallback cannot be derived from this file's location once packaged.
   *
   * Four levels up from `packages/app/out/main` is the repo root, which is what
   * a developer running `electron-vite dev` wants. Four levels up from
   * `Resources/app.asar/out/main` is `Contents` — so an installed app launched
   * from the Finder opened ITSELF as the project, indexed its own bundle, and
   * spawned terminals inside it. Correct arithmetic, meaningless answer.
   *
   * There is no cwd worth trusting either: Finder gives an app `/`. So the home
   * directory is the honest default, and ⌘O is how you get to a real project.
   */
  const projectRoot = argRoot
    ?? (app.isPackaged ? homedir() : resolve(import.meta.dirname, "../../../.."));

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(`${devUrl}?root=${encodeURIComponent(projectRoot)}`);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"),
                         { query: { root: projectRoot } });
}

// ── daemon ⇄ renderer bridge ──────────────────────────────────────────
// The main process is a dumb relay on purpose: all session logic lives in the
// daemon, all view state lives in the renderer. Nothing lives here.

const toRenderer = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

/**
 * Connection state is kept HERE, not only broadcast as an event.
 *
 * `link.connect()` runs in whenReady and connects in milliseconds — long before
 * the renderer registers listeners. An `open` emitted in that window is lost
 * forever, and the indicator stays stuck on "reconnecting" while the app works
 * perfectly. An event alone is never enough for STATE: there has to be a way to
 * ask "and right now, how is it?".
 */
let daemonState: "open" | "close" = "close";
let daemonDetail: string | undefined;
ipcMain.handle("daemon:status", () => ({ state: daemonState, detail: daemonDetail }));

link.on("open",    () => { daemonState = "open"; daemonDetail = undefined; toRenderer("daemon:open"); });
link.on("close",   () => { daemonState = "close"; toRenderer("daemon:close"); });
link.on("fatal",   (m: string) => { daemonState = "close"; daemonDetail = m; toRenderer("daemon:fatal", m); });
link.on("control", (ev: unknown) => toRenderer("daemon:control", ev));
link.on("pty",     (ptyId: string, data: Buffer) =>
  // Uint8Array crosses IPC's structured clone without an extra base64 copy.
  toRenderer("daemon:pty", ptyId, new Uint8Array(data)));

ipcMain.on("daemon:send",  (_e, req: unknown) => link.send(req));
ipcMain.on("daemon:write", (_e, ptyId: string, data: Uint8Array) => link.write(ptyId, data));

ipcMain.handle("dialog:pickFolder", async (): Promise<string | null> => {
  const r = await dialog.showOpenDialog({
    title: L("Abrir projeto", "Open project"),
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: L("Abrir", "Open"),
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  buildMenu();
  const ic = iconPath();
  if (ic && process.platform === "darwin") app.dock?.setIcon(ic);
  createWindow();
  link.connect();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// Only releases the socket. Killing the ptys here would destroy the reason the daemon exists.
app.on("before-quit", () => link.dispose());
