# dsh-plugin-tui

An interactive terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a Claude Code-style REPL over one resumable coding-agent session. Where `dsh-plugin-cli-session` drives a single turn and exits, this runner keeps the terminal for the whole conversation — streaming token deltas, tool-call lines, and turn errors as they commit, and answering approval requests from the keyboard.

## Install

```sh
dsh plugin --profile tui add github:ghbhiee/dsh-plugin-tui
```

Or from a local clone (a `link:`, so a local rebuild is picked up):

```sh
dsh plugin --profile tui add ./dsh-plugin-tui
```

The `tui` profile needs only two bundle layers — this plugin restates the few
rows dsh-headless would have contributed, so do NOT add the headless bundle:

```jsonc
// ~/.dsh/profiles/tui/package.json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-tui"] } }
```

## Usage

```sh
dsh --profile tui                       # start at the prompt
dsh --profile tui "explain this file"   # send a first message, then stay interactive
dsh --profile tui -r                    # resume the latest tui session here
dsh --profile tui -s <id>               # resume a specific session
dsh --profile tui -w ./scratch          # new session in another directory
dsh --profile tui -l                    # list this profile's sessions here
dsh --profile tui -p danger-full-access # full access from launch (no sandbox, no prompts)
dsh --profile tui -p workspace-write -y # sandboxed, but approvals auto-allowed
```

Inside the REPL:

| Input | Meaning |
|---|---|
| `/exit`, `/quit`, Ctrl-D | leave (flushes the session first) |
| `/session` | print the session id |
| `/sessions` | pick a session interactively (↑/↓ move, Enter switches, Esc cancels); `/sessions list` prints the static list |
| `/resume <n\|id>` | switch to another session in place (index from `/sessions list`, or an id prefix) |
| `/history [n]` | reveal n earlier exchanges of the current session (switching in shows only the most recent ones) |
| `/new` | start a fresh session, releasing the current one |
| `/title [text]` | show the session title, or rename it (a rename pins the title) |
| `/model [id]` | pick a model interactively (↑/↓, Enter, Esc) or hot-switch by name (`id` or `provider/id`) — takes effect from the next step |
| `/effort [id]` | pick reasoning effort interactively, or set by name (`/effort default` restores the provider default) |
| `/help` | built-ins plus every harness-registered command |
| Ctrl-C while a turn runs | cancel the turn, stay in the REPL |
| Ctrl-C twice while idle | leave |
| `y` / `N` at an approval prompt | allow / reject one gated tool call |
| `/approvals [ask\|auto]` | `auto` allows every request with a dim audit line (the sandbox still applies); `ask` restores prompts. `dsh --profile tui -y` starts in auto |
| a number (or free text) at a `⁇` question | pick an option / answer in your own words; multi-select takes comma-separated numbers |

A status bar pinned to the terminal's bottom row shows the live model and
effort, the approvals mode, the session title, and the working directory —
it refreshes as those change and survives resizes; the transcript scrolls
above it. Thinking is collapsed by default — the spinner area shows a live
three-line window over the reasoning stream, and **ctrl+o** toggles the full
dim stream.
`/model` and `/effort` choices are remembered per profile (`tui-model.json`
beside the profile; the machine-wide default is never touched) — `/model
default` clears the preference.
Tool calls always render as one task-summary line (`⏺ Group counts (+14
lines)`); the full command or script goes to the same per-turn detail stream
ctrl+o reveals. The toggle only ever covers the current (or just-finished)
exchange — starting a new one clears it.
Resuming or switching to a session replays its recent exchanges statically
(never re-running anything); `/history` pages further back, and your
terminal's own scrollback covers the rest. The prompt appears in well under a
second — MCP servers connect in the background and their tools join late.
While a turn runs, a braille spinner covers quiet stretches; token deltas are
micro-batched (~16ms) so heavy streams stay smooth. Answer text renders as
markdown, a line at a time — bold headings, colored bullets and inline code,
green fenced code blocks. Tool calls render through each tool's own presenter —
`⏺ $ ls -la — List files`, `⏺ Write foo.txt` — with the `⏺` colored by the
call's category (read, edit, execute, …), falling back to a compact
raw-arguments line for tools without one. Todo snapshots draw as a ☑/◐/☐
checklist, each exchange ends with a dim `↳ 1.2k in · 89 out` accounting line,
and prompt history persists across runs (up-arrow recalls earlier inputs).

Ctrl-C works as a keystroke because raw-mode readline owns the terminal; the
launcher's own SIGINT handler still answers an external `kill -INT` with a full
teardown, which is the behavior you want from outside the TUI.

## Develop

```sh
pnpm install
pnpm run check   # typecheck → vitest → tsdown build
```

Because `lib/` is versioned (it is what a git install serves), rebuild and
commit it with every source change.

Harness slash commands are dispatched through `ctx.commands`, so `/help` also
lists whatever the composition registers — here that is `/compact`,
`/feedback`, `/goal`, `/permission`, and `/plan`. `/permission
workspace-write` switches the live session to the sandboxed ask-mode preset;
gated tool calls then surface as the y/N approval prompt.

## Status / known gaps

- One-shot approvals only: the harness approval seam carries no tool arguments
  and no allow-always vocabulary, so there is no per-command allowlist yet.
- Plan review (`/plan` → `exit_plan_mode`) renders through the generic
  question flow — the plan markdown prints as the question's detail — rather
  than a dedicated diff-style view.
- Token deltas are written unbatched; heavy streams may want coalescing.
- Any sibling plugin in the profile that logs to stdout will paint over the
  REPL. Rows inserted by the machine-wide `~/.dsh/cordis.patch.yml` cannot be
  overridden from a profile patch (the global user layer applies above it), so
  silence chatty MCP proxies in the global file itself — e.g. wrap the command
  as `sh -c 'exec npx … 2>>"$HOME/.dsh/mcp-<name>.log"'`.
- `ctx.commands.execute` has a signature drift between the installed
  0.1.1-rc.2 (`agent, line, images, signal`) and the published rc.6 types
  (`agent, line, signal`); the runner dispatches on arity.
