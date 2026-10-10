# `config` command — design

Status: **implemented**, 2026-10-11 (proposed 2026-10-10 as `setup`).

## 🎯 Problem

Registering a host means writing an MCP server entry by hand: the right file for the right
client, the `command` / `args` shape, and a dozen `SSH_*` variable names nobody remembers.
A typo is only discovered when the agent's first call fails. The client is not always
Claude Code either — Codex keeps its servers in TOML, Claude Desktop and Cursor in their
own JSON files.

## ✅ Decisions

| Question | Decision |
|---|---|
| Entry point | `akms-mcp-ssh config` — a management UI (list / add / edit / remove / check / print / switch client), not a one-shot wizard |
| Claude Code scope | **user only** (`~/.claude.json`). Project `.mcp.json` dropped — an SSH host belongs to a person, not a repo |
| Paste-ready output | yes — Print shows JSON, a Codex TOML table and a `claude mcp add-json` line |
| Flags | `--target <client>` only. No `--host` / `--user` flags: they would bring back the names the wizard hides |
| Choosing | arrow-key lists, not typed keywords (revised 2026-10-11 after first use: typing `claude-code` or `password` to pick an option was the main complaint) |

## 🧭 Flow

```
config [--target <client>]
 └─ loop: the hosts in the current client's file ARE the menu
     ├─ <host>          → Edit / Check the connection / Print the entry / Remove / Back
     │    ├─ Edit       the settings form, pre-filled → preview → write;
     │    │             a rename writes the new name, then removes the old
     │    ├─ Check      connect with the stored entry; offer to pin an unpinned key
     │    ├─ Print      JSON + TOML + claude CLI line, real secrets included
     │    └─ Remove     confirm (default No)
     ├─ Add a host      the settings form → preview → write
     ├─ Switch client   claude-code / codex / claude-desktop / cursor
     └─ Quit            (Esc, Ctrl+C, Ctrl+D and a script running out also quit)
```

**The settings form** (revised 2026-10-11 from a question sequence, after first use: one
wrong answer meant walking every question again). Every setting is a row with its value:

```
? New host
❯ Host             (required)
  Port             22
  User             (required)
  Server name      ssh-<host>            follows the host until you change it
  Authentication   Private key file
    Private key    ~/.ssh/id_ed25519
    Passphrase     none
  Route            Directly
  Description      none                  shown to the agent
  Read-only        no                    enter toggles
  File paths       anywhere              where the file tools may read and write
  Host key         not pinned
  ────────────────────────
  Test the connection  not run yet
  Save                 to Claude Code (user scope)
  Cancel
```

- Picking a row edits that setting and returns to the form. The cursor then moves to the
  next row, so Enter down the list fills the form in order; random access stays available.
- A choice that brings settings with it adds their rows under it and asks for the required
  ones at once — key auth asks for the key (picked from `~/.ssh`), a jump host route asks
  for the jump host. A parent edit moves the cursor past its rows.
- Settings of a route or auth no longer chosen are kept while the form is open (switching
  back restores them) and dropped on Save.
- `(required)` marks what the entry cannot do without. Save names what is missing and
  moves the cursor to the first one.
- The server name follows the host until it is edited by hand.
- Read-only toggles on Enter. Host key: pinned → offer to unpin (default No); not pinned →
  run the test, which offers the pin.
- Save settles a name clash, then offers a test if the values changed since the last
  successful one. A failed test offers Back to the settings / Save anyway / Discard.
- Cancel or Esc leaves at once from an untouched form, and asks first from a changed one.
- On a TTY the form redraws in place: `Prompter.transient` makes answered prompts leave
  no line behind, since the form already shows every value.

In a text field Enter keeps the value shown and `-` clears an optional one.

**Two input modes.** On a TTY, a list is driven by ↑/↓ (or k/j), 1–9, Enter and Esc, and
every answered prompt collapses to one `✔ question · answer` line. Off a TTY — a pipe, the
tests, Git Bash's mintty without winpty — the same list is numbered and answered by number,
key or label. Both come from one `Prompter.select`, so the scripted tests drive the same
menu a person sees. No prompt library: `@clack/prompts` and `@inquirer/prompts` each take
over stdin with their own readline, which would fight the line reader the other prompts
use, and every dependency is also downloaded by each `npx -y` launch of the server.

## 🔧 Rules

- **Defaults are not written.** Port 22, a jump user equal to the login user, read-only off
  — the entry reads like the README examples.
- **The wizard owns a fixed set of variables.** Everything else under `SSH_*` (timeouts,
  deny patterns, `SSH_NAME`, `SSH_CWD`, jump credentials) is carried through an edit
  untouched, except `SSH_JUMP_*` once the jump host is removed — the server would refuse
  to start with a stray one.
- **Server names are `[A-Za-z0-9_-]{1,48}`.** The name becomes part of every tool name
  (`mcp__<name>__ssh_exec`); the default `ssh-<host>` has dots replaced.
- **The check is the server's own startup path.** The built env goes through
  `loadHostProfile(env)` and the same report `--check` prints, so a value the server would
  reject is caught before writing, and a host that passes setup passes `--check`.
- **Pinning is offered, re-pinning is not defaulted.** An unpinned key gets "Pin it? [Y/n]".
  A pinned key that no longer matches gets "[y/N]" — it is also what an impersonated host
  looks like.
- **Secrets** are masked in the preview and shown in the print view, which exists to be copied.
- **Windows** entries launch through `cmd /c npx -y @akms/mcp-ssh`, the wrapper Claude
  Code prescribes for npx servers on native Windows.

## 🗂️ Targets

| Target | File | Write method |
|---|---|---|
| `claude-code` | `~/.claude.json` | delegated to `claude mcp add-json … -s user` / `claude mcp remove`; read directly |
| `codex` | `~/.codex/config.toml` | section-level text rewrite (below) |
| `claude-desktop` | `%APPDATA%\Claude\…` · `~/Library/Application Support/Claude/…` · `~/.config/Claude/…` | JSON merge |
| `cursor` | `~/.cursor/mcp.json` | JSON merge |

Detected targets (CLI on `PATH` or file exists) are listed first; the first is the default.

**Claude Code is delegated** because `~/.claude.json` is Claude Code's own state file —
rewritten by the running process, `mcpServers` one key among many. `add-json` refuses an
existing name, so an edit is remove-then-add; a failed add restores the previous entry. An
npm-installed `claude.cmd` cannot be spawned without a shell, so it goes through `cmd.exe`
with cross-spawn's escaping (MSVCRT quoting, then `^` before every metacharacter, twice —
the shim re-parses `%*`). Without the CLI, the command to run is printed instead.

**Codex is rewritten by section**, with no TOML dependency. The file is split into header
sections; only `[mcp_servers.<name>]` and its `.env` table are rebuilt. Keys the user added
to the server table (`startup_timeout_sec`) and other sub-tables (`.tools.*`) stay, every
other line is returned byte for byte, CRLF is kept. Multi-line strings (`"""`) are not read.

**JSON files** are read → `mcpServers[name]` set → written with 4-space indent. A file that
does not parse is never written; the UI says so and offers only switch / quit.

## 🏗️ Code

```
src/modules/manage/
├── index.ts             runConfigCommand() — the host menu, check/print/remove, preview + write
├── host-form.ts         the settings form for add / edit; key discovery; test + pin
├── prompter.ts          select / text / secret prompts over any stream pair
├── entry.ts             answers ⇄ entry, isOurEntry, list summary
├── connection-check.ts  the report shared with --check; env → profile as the server builds it
└── targets/             claude-code, codex (+ toml-subset), json-file, registry
```

`Prompter` owns stdin with a single `data` listener instead of `readline`: masking a secret
needs raw mode, and readline's listener would see those keystrokes too. Off a TTY every
prompt is a plain line read, which is what lets the tests script the whole UI.

## 🧪 Tests

| File | Covers |
|---|---|
| `manage-entry.test.ts` | defaults omitted, carried variables, stray jump variables, round trip, `loadHostProfile(env)` contract |
| `manage-toml.test.ts` | parse, append, replace keeping hand-added keys and sub-tables, remove, CRLF, idempotence |
| `manage-command.test.ts` | the whole UI over scripted stdin against a live in-process `ssh2.Server` and a temp JSON file: the settings form (rows and values, required marks, rows a route brings, discard confirm), add + pin, masked preview, failed check, rename, check-to-pin, print, remove, unreadable file |
| `manage-prompter.test.ts` | arrow-key select on a simulated TTY (separators skipped, wrap-around, 1–9, Esc, Ctrl+C restores raw mode), answer collapsing, unechoed secrets, numbered fallback |
| `manage-cli-shim.test.ts` | Windows only — a JSON payload full of metacharacters through npm's exact `.cmd` template, byte for byte |

Not covered by tests: the real `claude mcp` CLI writing `~/.claude.json`, and raw-mode
masking on a real terminal.
