# retroCode

A macOS IDE that wraps the Claude Code CLI instead of replacing it — with a live
lens over your sessions: which one is waiting on you, what it touched, what it cost.

![retroCode](docs/screenshot.png)

## The problem

Running several `claude` sessions at once is the normal way to work now. The
problem is that a terminal is a river: the transcript scrolls, and with it goes
everything you needed to know. Which session finished? Which one is blocked on a
permission prompt? Which one is about to compact its context? What files did the
one in the other tab actually change?

Claude Code already writes all of that down. It keeps a JSONL transcript per
session under `~/.claude/projects/`, appended line by line while the session
runs. retroCode reads those transcripts live and turns them into a panel.

That panel — **the lens** — is the whole product:

- every session in this repo, with its state: *working*, *your turn*, *waiting
  for approval?*, *idle*
- context used against the model's window, so you see a compaction coming
- estimated spend per session (the CLI records tokens, not money)
- the files each session touched, and a one-click diff of just those files
- which session belongs to the pane in front of you

## The stance

**The real CLI runs inside it.** Not a reimplementation, not an API client with
a chat panel. Terminals here are real ptys running your `$SHELL`, and `claude`
in them is the same binary with your MCP servers, your permissions, your
history. The IDE never submits a prompt for you.

Everything the IDE composes — a file, a Linear issue, a Notion page — is
**pasted into the composer and left there**. You read it, you edit it, you press
enter. Context injection that submits on your behalf is a different product.

Connectors need no credentials in the IDE. Linear and Notion are fetched through
a headless `claude -p` scoped to a single MCP tool, so the authentication is the
one your CLI already has.

## Architecture

Two processes, and one rule that decides what goes where.

```
retroCode.app (Electron)      main + preload + renderer
    │ unix socket ~/.retro/retrod.sock
    │ frames: [kind:u8][len:u32be][payload] — JSON for control, raw bytes for ptys
retrod (Node)                 PtyManager · SQLite · transcript watcher · Agent SDK
    │
    └─ /bin/zsh -l            one per terminal
```

**The daemon owns processes, not content.** No text buffer, no AST, no document
crosses that socket — typing latency never pays for an IPC hop. What the daemon
does own is everything with a long life: ptys, the SQLite store, the file
watchers.

The payoff is verified, not theoretical: quit the app and the daemon and its
ptys stay alive; reopen and the scrollback replays. A daemon restart is survived
too — every terminal on screen reattaches, or gets a fresh pty if its own died.

Pty bytes get their own frame kind because a noisy build dumps megabytes per
second, and pushing that through JSON would cost ~33% in base64 plus the parse.
The control channel stays JSON because being readable under `socat` while
debugging is worth more than the microseconds.

## Running it

```bash
bun install          # postinstall patches three things — see below
bun run app          # the daemon starts itself
```

To watch the daemon's log while developing, run it in its own terminal instead:

```bash
bun run daemon       # terminal 1
bun run app          # terminal 2
```

Otherwise: `tail -f ~/.retro/retrod.log`.

To inspect the running renderer from a shell:

```bash
RETRO_DEBUG_PORT=9222 bun run app
node scripts/cdp.mjs 'document.querySelectorAll(".pane").length'
```

## Shortcuts

| | |
|---|---|
| `⌘J` | new terminal already running `claude` |
| `⌘D` / `⇧⌘D` | split below / split beside |
| `⌘W` | close pane |
| `⌘]` `⌘[` | cycle panes |
| `⌘P` | fuzzy file finder |
| `⌘K` | command palette |
| `⌘E` | file tree |
| `⌘O` | open project |
| `⇧⌘G` | diff this repo against HEAD |
| `⌘,` | settings |

## Configuration

Everything lives in `~/.retro/config.json`, and the settings pane edits that
same file — what the UI writes is what you would have written by hand, and what
you write by hand shows up in the UI. Saving it recolours the running IDE with
no restart.

```json
{
  "lang": "en",
  "theme": { "signal": "#EFA84C", "focus": "#7AA2F7" },
  "commands": [
    { "id": "monitor", "label": "monitor terminal", "run": "k9s || btop || top" }
  ]
}
```

- `lang` — `en` or `pt`. Omit it to follow the system language.
- `theme` — overrides for the design tokens, without the `--` prefix.
- `commands` — your own entries in the palette; each opens a terminal running
  its snippet.

## Three things `postinstall` repairs

`scripts/fix-native.mjs` exists because bun does not run install scripts the way
these packages need:

1. **`node-pty`** — bun's store extraction drops the execute bit from
   `spawn-helper`. Every pty spawn then fails with `posix_spawnp failed`, an
   error that mentions permissions nowhere.
2. **`electron`** — its `install.js` (which downloads the ~300MB binary) never
   runs, and `electron-vite dev` fails on an empty `path.txt`.
3. **the dev bundle's identity** — in development the app *is* node_modules'
   `Electron.app`, so macOS shows "Electron" everywhere. The bundle and its
   executable are renamed and `path.txt` is repointed. This is only safe because
   the prebuilt binary is ad-hoc *linker-signed*: `codesign` reports
   `Info.plist=not bound` and no sealed resources, so the hash covers the Mach-O
   alone.

## Stack

TypeScript end to end. Electron for the window, xterm.js with the WebGL renderer
for terminals, CodeMirror 6 for the editor, better-sqlite3 and node-pty in the
daemon, zod for the wire schema shared by both sides. No build step for the
daemon — Node strips the types.

## Status

Working today: tiling panes with layout persistence, terminals that outlive the
app, the lens, context and cost meters, side-by-side diff against HEAD, fuzzy
finder, command palette, editor with markdown preview, Linear and Notion
connectors, English/Portuguese UI, live theming.

Experimental, reachable from the palette: an agent pane driven by the Agent SDK,
and a multi-variant consensus runner that solves the same task N times in
disposable worktrees and classifies each file as identical, equivalent,
divergent or minority — so review happens by exception.

Not there yet: keyboard navigation inside the lens, recency grouping in the
session list, hunk-level accept in the diff, syntax highlighting inside the
diff.

## License

MIT.
