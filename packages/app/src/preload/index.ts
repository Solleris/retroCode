import { contextBridge, ipcRenderer } from "electron";

/**
 * The minimal surface exposed to the renderer. `contextIsolation` is on, so
 * this is the only door — the renderer has no Node, no fs, no require. A
 * renderer that displays agent output should not have more than this.
 */
const api = {
  send: (req: unknown): void => ipcRenderer.send("daemon:send", req),
  write: (ptyId: string, data: Uint8Array): void => ipcRenderer.send("daemon:write", ptyId, data),

  onControl: (cb: (ev: unknown) => void): void => {
    ipcRenderer.on("daemon:control", (_e, ev) => cb(ev));
  },
  onPty: (cb: (ptyId: string, data: Uint8Array) => void): void => {
    ipcRenderer.on("daemon:pty", (_e, ptyId, data) => cb(ptyId, data));
  },
  /** Opens in the system browser (the logged-in one), not an app window. */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("shell:openExternal", url),

  /** Native folder picker. It lives in main because only main has `dialog`. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),

  /** The CURRENT state, not the next event. Call this at startup. */
  daemonStatus: (): Promise<{ state: "open" | "close"; detail?: string }> =>
    ipcRenderer.invoke("daemon:status"),

  onStatus: (cb: (s: "open" | "close", detail?: string) => void): void => {
    ipcRenderer.on("daemon:open", () => cb("open"));
    ipcRenderer.on("daemon:close", () => cb("close"));
    ipcRenderer.on("daemon:fatal", (_e, m: string) => cb("close", m));
  },
};

contextBridge.exposeInMainWorld("retro", api);
export type RetroApi = typeof api;
