# Changelog

All notable changes to `@akms/mcp-ssh`. Dates are `YYYY-MM-DD`.

## 0.1.3 — 2026-10-11

### Changed

- **The host manager is `akms-mcp-ssh setup`.** `config` still opens it, so the name used
  in 0.1.0 – 0.1.2 keeps working, but it is no longer listed in `--help`.

### Fixed

- **Esc goes back one level everywhere in `setup`.** Inside the settings form, Esc in a
  choice list (authentication, route, private key), a text field or a secret returns to the
  form with the setting unchanged — including the follow-up a choice opened, so Esc at the
  jump-host question also restores the route. Esc at the "Write it?" preview reopens the form
  on the same values. Before, a list opened from the form ignored Esc, and a text field never
  saw it: on macOS / Linux the terminal handed the `ESC` byte over as part of the value.
- Text fields on a terminal are now a small line editor in raw mode (←/→, Home/End,
  Backspace/Delete, Ctrl+U), which is what makes Esc visible there.

## 0.1.2 — 2026-10-11

### Changed

- **Adding or editing a host opens a settings form** instead of a sequence of questions.
  Every setting is listed with its value; pick one to change it, in any order, as often as
  needed. The cursor then moves to the next setting, so Enter down the list still fills the
  form top to bottom. Settings a choice brings with it (the private key, the jump host) appear
  under it once chosen, empty required settings are marked, and Save moves to the first
  missing one. Test the connection and Save sit below the settings; Save offers a test when
  the values changed since the last one. On a terminal the form redraws in place.

## 0.1.1 — 2026-10-11

### Changed

- **`config` menus are arrow-key lists.** Options are picked with ↑/↓ and Enter instead of
  typing a keyword (`claude-code`, `password`, a menu letter). The hosts are the main menu:
  pick one to edit, check, print or remove it. The private key is chosen from the keys found
  in `~/.ssh`, and the route is one choice (directly / jump host / proxy command / both)
  instead of two yes/no questions. Answered prompts collapse to one `✔ question · answer`
  line. Without a terminal (a pipe, Git Bash's mintty) the lists are numbered instead.

## 0.1.0 — 2026-10-11

### Added

- **`akms-mcp-ssh config`** — an interactive manager for the hosts registered in an MCP
  client's config: list, add, edit, remove, check, print, switch client. It asks plain
  questions instead of `SSH_*` names, tests the connection, offers to pin the host key, and
  writes the entry. Targets Claude Code (user scope, through `claude mcp`), Codex
  (`~/.codex/config.toml`), Claude Desktop and Cursor. `--target <client>` picks one.
- **Jump host** — `SSH_JUMP_HOST` (with `SSH_JUMP_PORT` / `SSH_JUMP_USER` / `SSH_JUMP_KEY`
  / `SSH_JUMP_PASSPHRASE` / `SSH_JUMP_PASSWORD` / `SSH_JUMP_HOST_KEY`) connects to a
  bastion first and reaches the target over a forwarded TCP channel, as `ssh -J` does.
  User and key default to the target's.
- **Proxy command** — `SSH_PROXY_COMMAND` runs a command and speaks SSH over its
  stdin/stdout, as OpenSSH's `ProxyCommand` does; `%h` / `%p` / `%r` expand to the first
  hop. It carries the jump host when both are set, so "cloudflared to the bastion, then
  forward to the target" is one entry.
- A `SSH_JUMP_*` variable set without `SSH_JUMP_HOST` aborts startup, like every other
  half-formed value.
- `ssh_list_hosts` shows the route; `--check` prints it along with the jump host's key
  fingerprint.

### Changed

- `--check` now lets warnings and errors through instead of silencing the log entirely,
  so a missing key file or the proxy command's stderr (a `cloudflared` login prompt) is
  visible where the operator is looking. An explicit `SSH_MCP_LOG_LEVEL` still wins.

### Library API

- `SshHostProfile` gains `proxyCommand` and `jump` (`SshJumpProfile`); `SshHostSummary`
  gains `viaProxyCommand` and `jump`.
- `SshConnection.jumpHostKeyFingerprint`.
- `loadHostProfile(env?)` reads from the given record instead of `process.env` when one
  is passed.

## 0.0.3 — 2026-09-28

- `package.json` declares `repository`, `homepage` and `bugs` pointing at
  `github.com/alkemic-studio/npm.akms.mcp-ssh`.

## 0.0.2 — 2026-08-09

First release to reach the registry. `0.0.1` was built but never published, so the
configuration surface listed under **Removed** never actually shipped — it is recorded
here because the code carried it right up to this version.

### Changed

- **Configuration is environment variables only.** A host is declared with plain `SSH_*`
  variables in the MCP client's own server entry — one entry per host. "What is this
  server allowed to do" is now answerable by reading that entry, with no second file to
  find and no precedence order to reason about.
- Fronting several hosts means several server entries, each carrying its own connection
  and its own guard policy, declared where you read it.
- `--check` reports the one configured host instead of iterating profiles.

### Removed

- Every config-file source: the `--config <path>` flag, `SSH_MCP_CONFIG`,
  `~/.akms-ssh.json` and `~/.config/akms-ssh/config.json` — along with the `defaults`
  block, the `hosts` map and the zod schema that validated them.
- The `target` argument on every tool. With one host there is nothing to select, so the
  model cannot name a machine even in principle.
- `ssh_reload_config`. Environment variables are fixed for the life of the process, so
  applying a change means restarting the server.
- `privateKey` (inline key contents), `passphraseEnv` and `passwordEnv`. `SSH_KEY` takes a
  path and `SSH_PASSPHRASE` / `SSH_PASSWORD` are themselves environment variables, so the
  indirection had nothing left to point at.
- The protected-local-path rule for `.akms-ssh.json`. The files that define the guards are
  now the MCP client configurations (`.mcp.json`, `.claude*`,
  `claude_desktop_config.json`), which stay protected.

### Library API

- `loadConfig(path?)` → `loadHostProfile()`, returning `SshHostProfile | null`.
- `createSshMcpServer(options?)` → `createSshMcpServer()`. The instance exposes `profile`
  instead of `config`, and `reloadConfig()` is gone.
- Dropped the `SshMcpConfig` and `SshMcpServerOptions` types and the `POLICY_INPUT_SCHEMA`
  / `HOST_INPUT_SCHEMA` / `CONFIG_INPUT_SCHEMA` exports.

### Unchanged

The guards. Catastrophe rules, `SSH_READONLY`, `SSH_ALLOW_SUDO`, `SSH_ALLOW_COMMANDS`,
`SSH_DENY_PATTERNS` and `SSH_ALLOWED_PATHS` screen exactly what they did before, at the
same chokepoint inside `SshConnection.exec` and the SFTP operations. A malformed value
still aborts startup rather than being ignored.
