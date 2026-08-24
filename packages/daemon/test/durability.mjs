/**
 * Does a terminal survive the death of the daemon?
 *
 * That is the whole question, and it only has a real answer if the daemon
 * actually dies. So this test starts a retrod of its own (isolated RETRO_HOME),
 * opens a terminal, leaves a long-running child in it, SIGTERMs the daemon, and
 * then asks the operating system whether the shell is still there.
 *
 * It is written to be truthful in BOTH modes: with tmux installed it asserts
 * survival and adoption, without it asserts the old behaviour. Run it before
 * and after `brew install tmux` and the verdict flips.
 *
 *   node packages/daemon/test/durability.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, sleep } from "./client.mjs";
import { SERVER_NAME } from "../src/tmux.ts";

const DAEMON = new URL("../src/main.ts", import.meta.url).pathname;
const PTY_ID = "pty-durabilidade";
const CWD = process.cwd();

const temTmux = (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
})();

function vivo(pid) {
  if (!pid) return false;
  try { execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" }); return true; } catch { return false; }
}
function filhos(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; }
}

const home = process.env.RETRO_HOME ?? mkdtempSync(join(tmpdir(), "retro-durable-"));
const sock = join(home, "retrod.sock");
// The helper resolves the socket from OUR env, not the daemon's — without this
// the test talks to the developer's real retrod, which is the last thing a
// destructive test should do.
process.env.RETRO_SOCKET = sock;

async function subirDaemon(rotulo) {
  const p = spawn("node", [DAEMON], {
    env: { ...process.env, RETRO_HOME: home },
    stdio: "ignore",
  });
  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);
  if (!existsSync(sock)) throw new Error(`${rotulo}: socket nunca apareceu`);
  await sleep(200);
  return p;
}

/** Open (or adopt) PTY_ID and report what the daemon said about it. */
async function abrirTerminal() {
  const c = connect();
  await c.ready();
  let nasceu = null, erro = null, saida = "";
  c.onControl((e) => {
    if (e.t === "terminalSpawned" && e.ptyId === PTY_ID) nasceu = e;
    if (e.t === "error") erro = e;
  });
  c.onPty((id, d) => { if (id === PTY_ID) saida += d.toString("utf8"); });
  await sleep(200);
  c.send({ t: "spawnTerminal", ptyId: PTY_ID, cwd: CWD, cols: 80, rows: 24 });
  for (let i = 0; i < 60 && !nasceu && !erro; i++) await sleep(100);
  return { c, nasceu, erro, saida: () => saida };
}

const linhas = [];
const registrar = (k, v) => { linhas.push([k, v]); console.log(`  ${k.padEnd(34)} ${v}`); };

/**
 * Start from nothing.
 *
 * The tmux server outlives the daemon by design, so it also outlives the test —
 * and a second run then ADOPTED the session left by the first, which made step 1
 * report `fresh: false` and quietly turned a full-lifecycle test into a partial
 * one. Killing our own server first is what keeps each run a real run. It is
 * ours alone (the name derives from RETRO_HOME), so this cannot touch the
 * developer's terminals.
 */
function limparServidor() {
  if (!temTmux) return;
  try { execFileSync("tmux", ["-L", SERVER_NAME, "kill-server"], { stdio: "ignore" }); } catch {}
}

console.log(`tmux: ${temTmux ? "presente — esperando terminal DURÁVEL" : "ausente — esperando o comportamento antigo"}`);
console.log(`RETRO_HOME: ${home}`);
if (temTmux) console.log(`servidor tmux: ${SERVER_NAME}`);
console.log();
limparServidor();

console.log("1. daemon inicial + terminal");
const d1 = await subirDaemon("d1");
const t1 = await abrirTerminal();
if (t1.erro) { console.log("  ERRO:", JSON.stringify(t1.erro)); process.exit(1); }
if (!t1.nasceu) { console.log("  nada voltou do spawnTerminal"); process.exit(1); }
registrar("pid do shell", t1.nasceu.pid);
registrar("fresh", String(t1.nasceu.fresh));

const shellPid = t1.nasceu.pid;

/**
 * Plant a child that nobody would want to lose — the stand-in for the
 * forty-minute build — and do NOT trust the first attempt.
 *
 * Typing into a shell that is still sourcing its rc is a race, and it loses
 * silently: observed once, zsh ran the `echo` and dropped the `sleep 600 &`
 * that came before it. The test then "passed" while asserting on a pid that
 * never existed, which is worse than failing. So the marker is the PROCESS,
 * not the echo: poll for it, and retype until the kernel agrees.
 */
async function plantarSleep() {
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    // Let the prompt settle: quiet output means the rc has finished talking.
    let anterior = -1;
    for (let i = 0; i < 40 && anterior !== t1.saida().length; i++) {
      anterior = t1.saida().length;
      await sleep(150);
    }
    t1.c.type(PTY_ID, "sleep 600 & echo MARCA-PRONTA\n");
    for (let i = 0; i < 50; i++) {
      const achado = filhos(shellPid).find((p) => {
        try {
          return execFileSync("ps", ["-p", String(p), "-o", "command="], { encoding: "utf8" })
            .includes("sleep 600");
        } catch { return false; }
      });
      if (achado) return { pid: achado, tentativas: tentativa };
      await sleep(100);
    }
  }
  return { pid: undefined, tentativas: 4 };
}

/**
 * Two invariants that only break silently.
 *
 * The env leak: passing the environment as ARGUMENTS put every variable on
 * display in `ps`, on a tmux server that lives for days. node-pty never did
 * that, so it would have been a downgrade introduced by the durability work.
 *
 * The CLAUDE_* leak: pty.ts sanitises the environment because a leaked
 * CLAUDE_CODE_SESSION_ID makes every `claude` in a Retro terminal write into
 * the LAUNCHER's transcript and the lens go blind. Under tmux that leak would
 * be permanent — the server hands its environment to every future pane — so it
 * is worth asserting from inside the shell itself.
 */
async function checarVazamentos(shellPid) {
  if (!temTmux) return { argvLimpo: true, semClaude: true };
  let ppid = 0;
  try {
    ppid = Number(execFileSync("ps", ["-p", String(shellPid), "-o", "ppid="], { encoding: "utf8" }).trim());
  } catch { /* shell already gone */ }
  let argv = "";
  try {
    argv = execFileSync("ps", ["-p", String(ppid), "-o", "command="], { encoding: "utf8" });
  } catch { /* server already gone */ }
  const argvLimpo = !argv.includes("PATH=");
  registrar("argv do servidor tmux", argvLimpo ? `limpo (${argv.trim().length} chars)` : "VAZANDO ENV");

  /*
   * Ask tmux, not `ps`.
   *
   * `ps -Ewwwp` on the pane returned 66 bytes — macOS simply will not show that
   * process's environment — so "no CLAUDE_* found" there was an artefact, not a
   * result. `show-environment -g` is what panes actually inherit, and it is the
   * only measurement that answered honestly.
   */
  let glob = "";
  try {
    glob = execFileSync("tmux", ["-L", SERVER_NAME, "show-environment", "-g"], { encoding: "utf8" });
  } catch { /* no server */ }
  const vazadas = (glob.match(/^CLAUDE[A-Z_]*=/gm) ?? []).length;
  const semClaude = vazadas === 0;
  registrar("CLAUDE* no env global do tmux", semClaude ? "0 (ok)" : `${vazadas} VAZANDO`);
  return { argvLimpo, semClaude };
}

const plantado = await plantarSleep();
registrar("shell respondeu", t1.saida().includes("MARCA-PRONTA") ? "sim" : "NÃO");
registrar("pid do sleep 600", plantado.pid ?? "NÃO ENCONTRADO");
if (plantado.tentativas > 1) registrar("tentativas até pegar", plantado.tentativas);
if (!plantado.pid) {
  console.log("\n  sem o processo filho não há o que provar — abortando");
  t1.c.close(); d1.kill("SIGTERM");
  process.exit(1);
}
const sleepPid = plantado.pid;
const vazamentos = await checarVazamentos(shellPid);
t1.c.close();

console.log("\n2. matando o daemon (SIGTERM)");
d1.kill("SIGTERM");
for (let i = 0; i < 50 && vivo(d1.pid); i++) await sleep(100);
await sleep(800);
registrar("daemon morto", vivo(d1.pid) ? "NÃO" : "sim");
const shellSobreviveu = vivo(shellPid);
const sleepSobreviveu = vivo(sleepPid);
registrar("shell sobreviveu", shellSobreviveu ? "SIM" : "não");
registrar("sleep 600 sobreviveu", sleepSobreviveu ? "SIM" : "não");

console.log("\n3. daemon novo — ele adota?");
const d2 = await subirDaemon("d2");
const t2 = await abrirTerminal();
registrar("fresh no 2º daemon", t2.nasceu ? String(t2.nasceu.fresh) : "nada voltou");
registrar("pid depois de readotar", t2.nasceu ? t2.nasceu.pid : "-");
const adotou = Boolean(t2.nasceu) && t2.nasceu.fresh === false && t2.nasceu.pid === shellPid;
registrar("mesmo shell de antes", adotou ? "SIM" : "não");

console.log("\nveredito");
// The leaks count toward the verdict: durability that publishes the launcher's
// session id is not a feature that shipped, it is two bugs that shipped.
const esperado = temTmux
  ? shellSobreviveu && sleepSobreviveu && adotou && vazamentos.argvLimpo && vazamentos.semClaude
  : !shellSobreviveu && Boolean(t2.nasceu) && t2.nasceu.fresh === true;
console.log(temTmux
  ? `  com tmux: sobreviveu=${shellSobreviveu} adotou=${adotou} argv-limpo=${vazamentos.argvLimpo} sem-CLAUDE=${vazamentos.semClaude} -> ${esperado ? "PASSOU" : "FALHOU"}`
  : `  sem tmux: shell morreu com o daemon (esperado), terminal novo nasceu fresh -> ${esperado ? "PASSOU" : "FALHOU"}`);

// Leave nothing running: this test's whole premise is processes that outlive
// their parent, which is also the perfect way to litter a machine.
if (t2.nasceu) t2.c.send({ t: "killTerminal", ptyId: PTY_ID });
await sleep(400);
t2.c.close();
d2.kill("SIGTERM");
await sleep(500);
limparServidor();
await sleep(300);
for (const p of [sleepPid, shellPid]) if (vivo(p)) { try { process.kill(p, "SIGKILL"); } catch {} }
process.exit(esperado ? 0 : 1);
