/**
 * Rasterises assets/icon.svg → icon.png (1024) + icon.icns.
 *
 * Runs INSIDE electron rather than pulling in a rasterisation library: the
 * Chromium is already installed, renders SVG better than any binding, and this
 * avoids a build dependency that would exist only to draw an icon.
 *   ./node_modules/electron/dist/retroCode.app/Contents/MacOS/retroCode scripts/make-icon.mjs
 */
import { app, BrowserWindow } from "electron";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const ASSETS = join(ROOT, "packages/app/assets");
const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });

/*
 * EVERYTHING inside whenReady().then, no top-level `await` in the module.
 *
 * Electron only emits `ready` AFTER the main ESM module's evaluation resolves.
 * A top-level `await app.whenReady()` is therefore a perfect deadlock: the
 * module waits for ready, ready waits for the module. And it produces no error
 * at all — the process stays alive and mute forever.
 */
app.whenReady().then(async () => {
  const svg = readFileSync(join(ASSETS, "icon.svg"), "utf8");

  // HTML in a file, not in a `data:` URL — Chromium blocks top-level
  // navigation to data: URLs and the loadURL never resolves.
  const page = join(tmpdir(), "retro-icon.html");
  writeFileSync(page, `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:1024px;height:1024px}</style>${svg}`);

  // The window IS shown, just off screen: capturePage() on a hidden window
  // waits for a compositor frame that never arrives on macOS.
  const win = new BrowserWindow({
    width: 1024, height: 1024, useContentSize: true, x: -2400, y: -2400,
    show: true, frame: false, transparent: true, backgroundColor: "#00000000",
  });

  await win.loadFile(page);
  await win.webContents.executeJavaScript(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");

  const shot = await win.webContents.capturePage();
  const raw = join(ASSETS, ".icon-raw.png");
  writeFileSync(raw, shot.toPNG());
  console.log(`captured ${shot.getSize().width}×${shot.getSize().height}`);

  // Normalise the master at 1024 — on a Retina display the capture is 2×.
  const master = join(ASSETS, "icon.png");
  sips("-s", "format", "png", "-z", "1024", "1024", raw, "--out", master);
  rmSync(raw);

  // .icns requires exactly these ten names; iconutil rejects the folder if one is missing.
  const iconset = join(ASSETS, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const [px, name] of [
    [16, "icon_16x16.png"],   [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],   [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],[256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],[512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],[1024, "icon_512x512@2x.png"],
  ]) sips("-z", String(px), String(px), master, "--out", join(iconset, name));

  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(ASSETS, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("generated icon.png + icon.icns");
  app.exit(0);
}).catch((e) => { console.error("failed:", e); app.exit(1); });
