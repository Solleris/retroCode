/**
 * Builds the daemon into real JavaScript, for the packaged app only.
 *
 * `tsc -b` deliberately cannot do this: tsconfig.base.json is
 * emitDeclarationOnly because an accidental `dist/main.js` once shadowed the
 * working source and the daemon stopped starting — the trap that daemon-link.ts
 * documents at length. So the executable artefact gets its own script, run on
 * purpose, never as a side effect of a typecheck.
 *
 * The output lands where the app already looks. daemon-link.ts resolves
 * `../../../daemon/dist/main.js` from import.meta.dirname, which inside a
 * packaged app is `Resources/app.asar/out/main` — three levels up is
 * `Resources`. Shipping this directory to `Resources/daemon/dist` therefore
 * needs no code change at all.
 *
 *   node scripts/build-daemon.mjs
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PKG = join(ROOT, "packages/daemon");
const DIST = join(PKG, "dist");

/*
 * Left as real dependencies instead of bundled.
 *
 * The two native ones locate their own `.node` binary at runtime by walking
 * directories (node-gyp-build), which bundling breaks. The agent SDK ships a
 * CLI it spawns, so it needs to stay a package on disk too.
 */
const EXTERNAL = ["node-pty", "better-sqlite3", "@anthropic-ai/claude-agent-sdk"];

const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

// The .d.ts files from `tsc -b` live here too; only the build output is ours to
// remove, so the directory is rebuilt from scratch rather than cleaned field by
// field. A stale main.js is exactly the failure this file exists to avoid.
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [join(PKG, "src/main.ts")],
  outfile: join(DIST, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 43 carries Node 22; the daemon also runs under the system node in
  // development, which is newer. The older of the two is the one to target.
  target: "node22",
  external: EXTERNAL,
  sourcemap: true,
  logLevel: "info",
});

/*
 * A package.json next to the bundle, for two reasons that both bite silently.
 *
 * `"type": "module"`: without it Node reads a `.js` next to no manifest as CJS
 * and dies on the first `import` — the daemon would fail before its own logging
 * exists, which is the mute failure daemon-link.ts warns about.
 *
 * The dependency list: `bun install` here builds a self-contained node_modules
 * that Node finds by walking up from main.js. Copying the workspace's tree
 * instead would copy symlinks into bun's global store, and those break the
 * moment the .app is moved to another machine.
 */
const deps = Object.fromEntries(EXTERNAL.map((d) => [d, manifest.dependencies[d]]));
writeFileSync(join(DIST, "package.json"), JSON.stringify({
  name: "@retro/daemon-dist", private: true, type: "module", dependencies: deps,
}, null, 2) + "\n");

// --backend=copyfile: the default backend hardlinks or symlinks into the global
// store, and a hardlink farm cannot be handed to another machine inside a .app.
execFileSync("bun", ["install", "--production", "--no-save", "--backend=copyfile"], {
  cwd: DIST, stdio: "inherit",
});

/*
 * Restore the execute bit on node-pty's spawn-helper.
 *
 * Same hole scripts/fix-native.mjs patches for the workspace, for the same
 * reason: a copy that loses +x turns every pty spawn into `posix_spawnp
 * failed`, an error that mentions permissions nowhere.
 */
let fixed = 0;
(function walk(dir, depth = 0) {
  if (depth > 12) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name === "spawn-helper" && (statSync(p).mode & 0o111) === 0) {
      chmodSync(p, 0o755);
      fixed++;
    }
  }
})(DIST);

console.log(`daemon empacotado em ${DIST.replace(ROOT, "")}${fixed ? ` (+x em ${fixed} binário)` : ""}`);
