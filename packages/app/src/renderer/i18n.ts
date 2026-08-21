/**
 * Localisation: English and Portuguese, no dependency.
 *
 * Three decisions worth explaining:
 *
 * 1. ONE dictionary, not a file per language. With two languages, separate
 *    files only create the chance of one falling behind unnoticed — side by
 *    side, a missing translation is obvious while you are writing it.
 *
 * 2. Plurals via a "|" separator. English and Portuguese are both two-form
 *    languages (1 / rest), so the entire rule fits on one line. The day a
 *    three-form language arrives (Russian, Polish), this becomes
 *    Intl.PluralRules and the keys do not change.
 *
 * 3. Changing the language reloads the window. Strings are read at render
 *    time, so re-rendering everything is what applies the new language — and
 *    the whole window is exactly that. A reactive system here would be
 *    machinery for an event that happens once per install.
 */

export type Lang = "pt" | "en";

const KEY = "retro.lang";

/**
 * Language: saved preference > system locale > English.
 *
 * `navigator.language` in the renderer comes from `app.getLocale()`, which on
 * macOS follows the system language. Anyone whose mac is in one language but
 * who works in another switches once and the choice sticks.
 */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "pt" || saved === "en") return saved;
  } catch { /* localStorage bloqueado: cai no locale */ }
  return navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
}

export const lang: Lang = detect();

export function setLang(l: Lang): void {
  try { localStorage.setItem(KEY, l); } catch { /* carry on regardless */ }
  location.reload();
}

type Entry = { pt: string; en: string };

const DICT: Record<string, Entry> = {
  // ── status bar / general ─────────────────────────────────────────────
  "app.emptyPane":      { pt: "vazio",  en: "empty" },
  "app.emptyHint":      { pt: "⌘J claude · ⌘T terminal · ⌘P arquivo",
                          en: "⌘J claude · ⌘T terminal · ⌘P file" },
  "app.footHint":       { pt: "⌘J claude · ⌘P arquivo · ⌘K comandos",
                          en: "⌘J claude · ⌘P file · ⌘K commands" },
  "app.daemonDown":     { pt: "retrod fora do ar — reiniciando",
                          en: "retrod is down — restarting" },
  "app.project":        { pt: "projeto", en: "project" },
  "app.openFileHere":   { pt: "abrir arquivo aqui", en: "open a file here" },
  "app.binary":         { pt: "— binário —", en: "— binary —" },
  "app.code":           { pt: "código", en: "code" },
  "app.noWebgl":        { pt: "[retro] WebGL indisponível; usando renderer canvas",
                          en: "[retro] WebGL unavailable; falling back to canvas renderer" },

  // ── command palette ─────────────────────────────────────────────────
  "cmd.claude":         { pt: "nova sessão claude", en: "new claude session" },
  "cmd.ctxFile":        { pt: "mandar arquivo pro claude", en: "send a file to claude" },
  "cmd.open":           { pt: "abrir arquivo", en: "open file" },
  "cmd.proj":           { pt: "abrir projeto…", en: "open project…" },
  "cmd.tree":           { pt: "árvore de arquivos", en: "file tree" },
  "cmd.term":           { pt: "shell aqui (mesmo diretório)", en: "shell here (same directory)" },
  "cmd.splitD":         { pt: "split abaixo", en: "split below" },
  "cmd.splitR":         { pt: "split ao lado", en: "split beside" },
  "cmd.close":          { pt: "fechar pane", en: "close pane" },
  "cmd.save":           { pt: "salvar", en: "save" },
  "cmd.diff":           { pt: "diff do repo (vs HEAD)", en: "repo diff (vs HEAD)" },
  "cmd.monitor":        { pt: "terminal de monitor (k9s/btop)", en: "monitor terminal (k9s/btop)" },
  "cmd.lang":           { pt: "idioma: mudar para inglês", en: "language: switch to Portuguese" },
  "palette.emptyIndex": { pt: "índice vazio", en: "empty index" },
  "palette.files":      { pt: "arquivos", en: "files" },
  "palette.commands":   { pt: "comandos", en: "commands" },
  "palette.noMatch":    { pt: "nada encontrado", en: "no matches" },

  // ── side navigation ─────────────────────────────────────────────────
  "nav.pin":            { pt: "fixar árvore", en: "pin tree" },
  "nav.openOther":      { pt: "abrir outra pasta…  ⌘O", en: "open another folder…  ⌘O" },
  "nav.recents":        { pt: "recentes", en: "recent" },
  "nav.unsaved":        { pt: "não salvo", en: "unsaved" },
  "nav.open":           { pt: "abertos", en: "open" },
  "nav.none":           { pt: "nenhuma", en: "none" },
  "nav.files":          { pt: "arquivos", en: "files" },
  "nav.tasks":          { pt: "tasks", en: "tasks" },

  // ── the lens ────────────────────────────────────────────────────────
  "lens.sessions":      { pt: "sessões claude", en: "claude sessions" },
  "lens.noSessions":    { pt: "nenhuma neste repo — ⌘J abre",
                          en: "none in this repo — ⌘J starts one" },
  "lens.here":          { pt: "aqui", en: "here" },
  "lens.hereTitle":     { pt: "esta é a sessão do pane em foco",
                          en: "this is the focused pane's session" },
  "lens.working":       { pt: "trabalhando", en: "working" },
  "lens.stateYourTurn": { pt: "sua vez", en: "your turn" },
  "lens.yourTurn":      { pt: "esperando você", en: "waiting on you" },
  "lens.maybeGate":     { pt: "esperando aprovação?", en: "waiting for approval?" },
  "lens.idle":          { pt: "parada", en: "idle" },
  "lens.context":       { pt: "contexto", en: "context" },
  "lens.usage":         { pt: "usage", en: "usage" },
  "lens.costTitle":     { pt: "estimativa a partir dos tokens do transcript (o CLI não grava custo)",
                          en: "estimated from transcript tokens (the CLI doesn't record cost)" },
  "lens.branchTitle":   { pt: "abrir no navegador do sistema", en: "open in the system browser" },
  "lens.seeDiff":       { pt: "ver diff deste {n} arquivo|ver diff destes {n} arquivos",
                          en: "see diff for {n} file|see diff for {n} files" },
  "lens.files":         { pt: "arquivos tocados", en: "files touched" },
  "lens.plan":          { pt: "plano", en: "plan" },
  "lens.mcpFetching":   { pt: "buscando via MCP…", en: "fetching over MCP…" },
  "lens.mcpRefresh":    { pt: "atualizar via MCP (~15s)", en: "refresh over MCP (~15s)" },
  "lens.mcpFailed":     { pt: "falhou: {msg}", en: "failed: {msg}" },
  "lens.linearTitle":   { pt: "assigned pra você", en: "assigned to you" },
  "lens.linearEmpty":   { pt: "nenhuma issue aberta assigned", en: "no open issues assigned" },
  "lens.issueTitle":    { pt: "clica → busca descrição+comentários e COLA no composer (você revê e dá Enter)",
                          en: "click → fetches description+comments and PASTES into the composer (you review, you hit Enter)" },
  "lens.notionTitle":   { pt: "páginas recentes", en: "recent pages" },
  "lens.notionEmpty":   { pt: "nenhuma página recente", en: "no recent pages" },
  "lens.pageTitle":     { pt: "clica → busca o conteúdo e COLA no composer (você revê e dá Enter)",
                          en: "click → fetches the content and PASTES into the composer (you review, you hit Enter)" },

  // ── diff pane ───────────────────────────────────────────────────────
  "diff.title":         { pt: "diff · {repo}", en: "diff · {repo}" },
  "diff.computing":     { pt: "calculando…", en: "computing…" },
  "diff.refresh":       { pt: "atualizar", en: "refresh" },
  "diff.clean":         { pt: "working tree limpo — nada mudou desde o HEAD",
                          en: "clean working tree — nothing changed since HEAD" },
  "diff.summary":       { pt: "{n} arquivo|{n} arquivos", en: "{n} file|{n} files" },
  "diff.notARepo":      { pt: "não é um repositório git", en: "not a git repository" },
  "diff.binary":        { pt: "arquivo binário, {kb}KB — sem diff de texto",
                          en: "binary file, {kb}KB — no text diff" },
  "diff.truncated":     { pt: "⋯ patch truncado em {kb}KB",
                          en: "⋯ patch truncated at {kb}KB" },
  "diff.oversize":      { pt: "diff grande demais para esta leva — abra o arquivo direto",
                          en: "diff too large for this batch — open the file directly" },
  "st.A":               { pt: "novo",      en: "new" },
  "st.M":               { pt: "editado",   en: "edited" },
  "st.D":               { pt: "removido",  en: "deleted" },
  "st.R":               { pt: "renomeado", en: "renamed" },

  // ── settings ────────────────────────────────────────────────────────
  "set.title":          { pt: "preferências", en: "settings" },
  "set.pathTitle":      { pt: "este é o arquivo editado — dá para abrir à mão",
                          en: "this is the file being edited — you can open it by hand" },
  "set.broken":         { pt: "config.json com problema ({msg}) — os valores de fábrica estão em uso e o seu arquivo NÃO foi sobrescrito",
                          en: "config.json has a problem ({msg}) — factory values are in use and your file was NOT overwritten" },
  "set.language":       { pt: "idioma", en: "language" },
  "set.langSystem":     { pt: "seguir o sistema", en: "follow the system" },
  "set.langNote":       { pt: "a janela recarrega ao trocar; o menu do macOS segue o idioma do sistema",
                          en: "the window reloads on change; the macOS menu follows the system language" },
  "set.theme":          { pt: "tema", en: "theme" },
  "set.reset":          { pt: "voltar ao valor de fábrica", en: "back to the factory value" },
  "set.commands":       { pt: "comandos próprios", en: "your own commands" },
  "set.commandsNote":   { pt: "aparecem no ⌘K e rodam num terminal novo",
                          en: "they show up in ⌘K and run in a new terminal" },
  "set.cmdLabel":       { pt: "rótulo", en: "label" },
  "set.cmdRun":         { pt: "comando de shell", en: "shell command" },
  "set.add":            { pt: "adicionar", en: "add" },
  "set.remove":         { pt: "remover", en: "remove" },
  "cmd.settings":       { pt: "preferências", en: "settings" },

  // ── consensus (experiment, palette-only) ────────────────────────────
  "cons.divergent":     { pt: "divergente", en: "divergent" },
  "cons.minority":      { pt: "minoria", en: "minority" },
  "cons.equivalent":    { pt: "equivalente", en: "equivalent" },
  "cons.identical":     { pt: "idêntico", en: "identical" },
  "cons.hDivergent":    { pt: "texto E comportamento divergem — leia",
                          en: "text AND behaviour diverge — read it" },
  "cons.hMinority":     { pt: "só parte das variantes mexeu — as outras esqueceram?",
                          en: "only some variants touched it — did the others forget?" },
  "cons.hEquivalent":   { pt: "texto difere, comportamento igual — escolha uma",
                          en: "text differs, behaviour matches — pick one" },
  "cons.hIdentical":    { pt: "byte-a-byte igual nas três — não precisa ler",
                          en: "byte-identical across all three — no need to read" },
  "cons.ready":         { pt: "pronto", en: "ready" },
  "cons.readyReview":   { pt: "pronto para revisão", en: "ready for review" },
  "cons.placeholder":   { pt: "a tarefa — 3 agentes independentes vão resolver em paralelo",
                          en: "the task — 3 independent agents will solve it in parallel" },
  "cons.runTests":      { pt: "rodar testes", en: "run tests" },
  "cons.run":           { pt: "rodar 3×", en: "run 3×" },
  "cons.discarded":     { pt: "worktrees removidos", en: "worktrees removed" },
  "cons.uncovered":     { pt: " · nenhum teste cobre este arquivo",
                          en: " · no test covers this file" },
  "cons.adopt":         { pt: "adotar", en: "adopt" },
  "cons.seeDiff":       { pt: "ver diff", en: "see diff" },
  "cons.noTests":       { pt: "os testes não puderam ser medidos — sem esse sinal, arquivos com texto divergente são tratados como divergentes por precaução",
                          en: "tests could not be measured — without that signal, files whose text diverges are treated as divergent, on purpose" },
  "cons.noReadNeeded":  { pt: "consenso — {n} arquivo, nada para ler|consenso — {n} arquivos, nada para ler",
                          en: "consensus — {n} file, nothing to read|consensus — {n} files, nothing to read" },
  "cons.readThis":      { pt: "divergência — leia isto", en: "divergence — read this" },
  "cons.didNotRun":     { pt: ": não rodou", en: ": did not run" },
  "cons.ok":            { pt: "ok", en: "ok" },
  "cons.fail":          { pt: "falha", en: "failed" },

  // ── agent pane (experiment, palette-only) ───────────────────────────
  "ag.placeholder":     { pt: "o que fazer?  ⏎ envia · ⇧⏎ nova linha",
                          en: "what should it do?  ⏎ sends · ⇧⏎ new line" },
  "ag.send":            { pt: "enviar", en: "send" },
  "ag.idle":            { pt: "pronto", en: "ready" },
  "ag.thinking":        { pt: "pensando", en: "thinking" },
  "ag.needsYou":        { pt: "precisa de você", en: "needs you" },
  "ag.allow":           { pt: "aprovar ⏎", en: "allow ⏎" },
  "ag.always":          { pt: "sempre ⌥⏎", en: "always ⌥⏎" },
  "ag.wantsToRun":      { pt: "{tool} quer rodar", en: "{tool} wants to run" },
  "ag.alwaysAllowed":   { pt: "{tool} — sempre permitido", en: "{tool} — always allowed" },
  "ag.approved":        { pt: "{tool} — aprovado", en: "{tool} — approved" },
  "ag.denied":          { pt: "{tool} — recusado", en: "{tool} — denied" },

  // ── context injection ───────────────────────────────────────────────
  "inject.linear":      { pt: "Pega a issue {id} no Linear (MCP), lê descrição e comentários, e implementa. ",
                          en: "Fetch issue {id} from Linear (MCP), read its description and comments, then implement it. " },
  "inject.notion":      { pt: "Lê a página \"{title}\" no Notion (MCP) e usa como contexto: {url} — ",
                          en: "Read the page \"{title}\" in Notion (MCP) and use it as context: {url} — " },
};

/**
 * Translates. `n` selects the plural form; `{key}` interpolates.
 *
 * A missing key returns the key itself rather than an empty string — so an
 * oversight shows on screen as `lens.foo` and is impossible to miss, unlike a
 * blank space.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key];
  if (!entry) return key;

  let s = entry[lang];
  if (s.includes("|")) {
    const [one, many] = s.split("|");
    s = Number(vars?.["n"]) === 1 ? one! : many!;
  }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** The opposite of the current language — the switch command needs a target. */
export const otherLang: Lang = lang === "pt" ? "en" : "pt";
