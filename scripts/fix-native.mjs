/**
 * bun extracts packages from its store without preserving the execute bit, and
 * node-pty's `spawn-helper` is a binary it MUST be able to execute. Without it
 * every pty spawn fails with `posix_spawnp failed` — an error that mentions
 * permissions nowhere, which is why it costs an afternoon.
 *
 * Runs on postinstall so it survives `bun install` and version changes.
 */
import { readdirSync, statSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGETS = new Set(["spawn-helper"]);
let fixed = 0;

function walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, depth + 1);
    } else if (TARGETS.has(e.name)) {
      const mode = statSync(p).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(p, 0o755);
        console.log(`chmod +x ${p.replace(ROOT, "")}`);
        fixed++;
      }
    }
  }
}

for (const d of ["node_modules", "packages"]) walk(join(ROOT, d));
console.log(fixed ? `fix-native: fixed ${fixed} binary file(s)` : "fix-native: nothing to do");

/**
 * Second hole in the same family: electron's `install.js` (which DOWNLOADS the
 * ~300MB binary) also does not run under bun. Without it, `electron-vite dev`
 * fails complaining about an empty path in path.txt.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const electronDir = join(ROOT, "packages/app/node_modules/electron");
if (existsSync(electronDir) && !existsSync(join(electronDir, "dist"))) {
  console.log("fix-native: downloading the electron binary…");
  execFileSync(process.execPath, ["install.js"], { cwd: electronDir, stdio: "inherit" });
}

/**
 * Third hole: in dev the app IS node_modules' Electron.app, so macOS shows
 * "Electron" in cmd-tab, the Dock, the menu and Activity Monitor — plus the
 * generic icon. None of that comes from an API: it comes from the BUNDLE NAME,
 * the executable's filename and Info.plist.
 *
 * Rewriting Info.plist was not enough: the Dock tooltip and the process name
 * come from the filename, not the key. So the whole bundle is renamed —
 * `Electron.app` → `retroCode.app`, and `MacOS/Electron` → `MacOS/retroCode` —
 * and the electron package's `path.txt` is pointed at it. `path.txt` is what
 * electron-vite consults to find the binary, and it accepts any path relative
 * to `dist/`.
 *
 * These files can be touched because the prebuilt binary's signature is
 * `adhoc, linker-signed`: `codesign -dv` reports `Info.plist=not bound` and
 * `Sealed Resources=none`, meaning the hash covers only the Mach-O — and
 * renaming a file does not change its contents. If the plist were sealed,
 * editing it would kill the app at launch on Apple Silicon, and that is exactly
 * why the check was done BEFORE writing anything.
 *
 * It RENAMES rather than copies: a clone would cost 250MB and create two
 * truths. If someone reinstalls electron, `install.js` recreates the original
 * `Electron.app` and this step renames it again on postinstall — self-healing.
 */
import { copyFileSync, renameSync, writeFileSync } from "node:fs";

const BRAND = "retroCode";
const dist = join(electronDir, "dist");
const bundle = join(dist, `${BRAND}.app`);

if (existsSync(dist)) {
  // 1. o bundle
  const original = join(dist, "Electron.app");
  if (existsSync(original) && !existsSync(bundle)) {
    renameSync(original, bundle);
    console.log(`fix-native: bundle renamed to ${BRAND}.app`);
  }
}

if (existsSync(bundle)) {
  // 2. the executable — this is where the process name in `ps` and the Dock comes from
  const macos = join(bundle, "Contents/MacOS");
  if (existsSync(join(macos, "Electron")) && !existsSync(join(macos, BRAND))) {
    renameSync(join(macos, "Electron"), join(macos, BRAND));
    console.log(`fix-native: executable renamed to ${BRAND}`);
  }

  // 3. Info.plist. CFBundleExecutable MUST match the new name, otherwise macOS
  //    cannot find the binary and the whole bundle is unusable.
  const plist = join(bundle, "Contents/Info.plist");
  const pb = (...args) =>
    execFileSync("/usr/libexec/PlistBuddy", ["-c", args.join(" "), plist], { encoding: "utf8" }).trim();
  /*
   * Each key is checked ON ITS OWN, and that is not fussiness.
   *
   * The first version used CFBundleName as a sentinel for all three: on a
   * machine whose plist was already half-migrated, the name was "retroCode"
   * already, the guard skipped everything, and CFBundleExecutable was left
   * pointing at a file that had just been renamed — an unusable bundle. A
   * coarse sentinel lies about partial state.
   */
  const stamp = (key, value) => {
    const current = (() => { try { return pb(`Print :${key}`); } catch { return null; } })();
    if (current === value) return false;
    if (current === null) pb(`Add :${key} string ${value}`);
    else pb(`Set :${key} ${value}`);
    return true;
  };
  const changed = [
    stamp("CFBundleName", BRAND),
    stamp("CFBundleDisplayName", BRAND),
    stamp("CFBundleExecutable", BRAND),
    // Its own identity in LaunchServices: without this macOS treats the app as
    // "Electron" for saved state, notifications and its cached icon.
    stamp("CFBundleIdentifier", "dev.retrocode.app"),
  ].some(Boolean);
  if (changed) console.log(`fix-native: Info.plist rebranded as ${BRAND}`);

  // 4. the icon
  const icns = join(ROOT, "packages/app/assets/icon.icns");
  const target = join(bundle, "Contents/Resources/electron.icns");
  if (existsSync(icns) && (!existsSync(target) || statSync(icns).size !== statSync(target).size)) {
    copyFileSync(icns, target);
    console.log("fix-native: bundle icon replaced");
  }

  // 5. o ponteiro que o electron-vite segue
  const pathTxt = join(electronDir, "path.txt");
  const want = `${BRAND}.app/Contents/MacOS/${BRAND}`;
  if (!existsSync(pathTxt) || readFileSync(pathTxt, "utf8").trim() !== want) {
    writeFileSync(pathTxt, want);
    console.log("fix-native: path.txt now points at the new bundle");
  }

  // Finder/Dock cache the name and icon per bundle; touching the .app's mtime
  // and re-registering is the nudge that makes LaunchServices re-read it.
  try {
    execFileSync("/usr/bin/touch", [bundle]);
    execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
                 ["-f", bundle], { stdio: "ignore" });
  } catch { /* lsregister is a convenience, not a requirement */ }
}
