<h1 align="center">retroCode</h1>

<p align="center">
  <strong>Run ten Claude Code sessions without losing track of one.</strong><br>
  A macOS IDE that runs the real CLI in tiled terminals — and puts a live lens
  over every session: which one is waiting on you, what it changed, what it cost.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-end%20to%20end-3178C6.svg">
</p>

![retroCode](docs/screenshot.png)

## Why

Running several `claude` sessions at once is the normal way to work now. The
problem is that a terminal is a river: the transcript scrolls, and with it goes
everything you needed to know. Which session finished? Which one is blocked on a
permission prompt? Which one is about to compact its context? What files did the
one in the other tab actually change?

Claude Code already writes all of that down. It keeps a JSONL transcript per
session under `~/.claude/projects/`, appended line by line while the session
runs. retroCode reads those transcripts live and turns them into a panel.

## The lens

That panel is the whole product. For every session in the focused terminal's
repo it shows:

- **state** — *working*, *your turn*, *waiting for approval?*, *idle*
- **context** used against the model's window, so you see a compaction coming
- **estimated spend**, because the CLI records tokens and not money
- **the files it touched**, and a one-click diff of just those files
- **which session belongs to the pane in front of you** — click a row to jump to
  its pane, or resume one whose terminal is gone

## Quick start

Requirements: **macOS**, **Node ≥ 25**, [**bun**](https://bun.sh), and the
[**Claude Code CLI**](https://claude.com/claude-code) on your `PATH`.
Optionally **tmux**, which makes terminals survive a daemon restart — see
[Durable terminals](#durable-terminals).

```bash
git clone https://github.com/Solleris/retroCode.git
cd retroCode
bun install          # postinstall patches node-pty and electron for bun
bun run app          # the daemon starts itself
```

Press <kbd>⌘J</kbd> and you have a terminal already running `claude`, with the
lens tracking it on the right.

## Installing it as an app

`bun run app` is the development loop. To get a `retroCode.app` you can launch
from Spotlight instead:

```bash
bun run dist                       # → packages/app/release/mac-arm64/retroCode.app
ditto packages/app/release/mac-arm64/retroCode.app /Applications/retroCode.app
```

`dist` does three things: bundles the daemon to real JavaScript (the dev loop
runs the TypeScript directly, so this step exists only for the package), builds
the renderer, and produces the bundle — ad-hoc signed, which is what makes
macOS register it as an application rather than a folder that happens to launch.
`bun run dist:dmg` produces a .dmg instead.

The daemon ships in `Contents/Resources/daemon`, outside the asar archive: it
loads native modules, and node-pty execs a helper binary by path, which cannot
be done from inside an archive.

The build is signed for **this machine only**. Handing it to another Mac needs a
Developer ID and notarisation, or Gatekeeper refuses it on first launch.

## Durable terminals

retroCode runs the terminals from a background daemon (`retrod`) so that closing
the window does not kill your sessions. The daemon itself was still a single
point of failure, though: it owned the shells, so if it died — a crash, a
`kill`, whatever launched it going down — every terminal died with it.

Install tmux and it stops owning them:

```bash
brew install tmux
```

From then on each terminal is a tmux session on a private tmux server
(`tmux -L retro`, never your own). The shell belongs to that server, so retrod
can die and restart and the next one adopts the sessions that are still running
— the build keeps building. You will see the handover in `~/.retro/retrod.log`:

```
3 terminal(is) sobreviveram ao retrod anterior: pty-a1b2, …
pty adopt pty-a1b2 pid 4711 (tmux) /Users/you/code/api
```

Nothing about tmux is visible in the UI: no status bar, no prefix key, no escape
delay. Without tmux everything still works exactly as before — the terminals are
simply not durable.

To check it on your own machine, `node packages/daemon/test/durability.mjs`
starts a daemon of its own, leaves a long-running child in a terminal, kills the
daemon, and asks the operating system whether the shell is still there. It
asserts survival and adoption with tmux installed and the old behaviour without
it, so the verdict flips when you install tmux.

## Shortcuts

| | |
|---|---|
| <kbd>⌘J</kbd> | new terminal already running `claude` |
| <kbd>⇧⏎</kbd> / <kbd>⌥⏎</kbd> | newline in the prompt, without submitting |
| <kbd>⌘T</kbd> | new plain terminal |
| <kbd>⌘D</kbd> / <kbd>⇧⌘D</kbd> | split below / split beside |
| <kbd>⌘W</kbd> | close pane |
| <kbd>⌘]</kbd> <kbd>⌘[</kbd> | cycle panes |
| <kbd>⌘P</kbd> | fuzzy file finder |
| <kbd>⌘K</kbd> | command palette |
| <kbd>⌘E</kbd> | file tree |
| <kbd>⌘O</kbd> | open project |
| <kbd>⌘S</kbd> | save the focused editor |
| <kbd>⇧⌘G</kbd> | diff this repo against HEAD |
| <kbd>⌘,</kbd> | settings |
| <kbd>⇧⌘W</kbd> | close the window |

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

## Contributing

Issues and pull requests are welcome. Two things worth knowing before a big one:

- **Open an issue first** for anything that changes the architecture. The split
  between the daemon and the renderer is deliberate: the daemon owns processes,
  not content. That rule is the one to argue with.
- **Comments here explain *why*, not *what*.** The codebase documents the
  decision and the failure that motivated it, not the syntax on the next line.
  Matching that is the main review note anyone gets.

```bash
bun run typecheck    # tsc -b across the three packages
bun run daemon       # terminal 1, to watch the daemon's log
bun run app          # terminal 2
```

To inspect the running renderer from a shell:

```bash
RETRO_DEBUG_PORT=9222 bun run app
node scripts/cdp.mjs 'document.querySelectorAll(".pane").length'
```

Otherwise the daemon's log is at `~/.retro/retrod.log`.

## License

[MIT](LICENSE)
