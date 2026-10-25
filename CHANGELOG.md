# Changelog

All notable changes to `@akms/mcp-ssh`. Dates are `YYYY-MM-DD`.

## [0.3.0] - 2026-10-26

- Detect older registry formats in standalone config and the helper menu. Add reviewed, ordered migrations with default-No approval, script APIs, complete pre-migration backup, rollback preservation and post-apply startup checks. Runtime can change the default for future kinds without changing existing modes.

- Start new registries in version 2 session mode. Register/Add/Import create per-kind bundles automatically; missing runtimes keep imported legacy entries until installation and Sync. Existing v1 migration and v2 per-kind rollback choices are preserved.

- Add session servers (default for new catalogs, opt-in migration for existing version 1 catalogs): one direct-Node `akms_<kind>` entry per client session, connection-prefixed tools, registry version 2, reviewed migration and rollback, and startup tool coverage checks.
- Preserve one atomic `registry.previous.json` revision per catalog-changing operation; keep externally edited client entries for Sync and retain old entries until replacements are verified.
- Validate connection-name budgets; document credential location and recovery in session mode. Show runtime paths in startup failures, accept string protocol versions, and explain file-lock update failures.

- Check MCP startup after saves, runtime conversion and Updates; add an on-demand Updates screen and default registration removal to No.

- Document plaintext catalog credentials, platform permissions, transfer-guard limits and recovery; show one privacy notice during Register review and a catalog notice in --help.
- Keep custom-command edits and host-key saves independent of the managed runtime; continue with a still-usable installed runtime after an update failure.

- Install managed server runtimes under `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`, independent of Node versions. Convert existing npx and global paths through Runtime; preserve development links.
- Offer older-runtime updates before Add/Edit and check installation before host-key saves. Include the last npm error lines without ANSI controls, and recognize Unix npm JavaScript paths while skipping version-manager shims.

- Generate direct Node launches using the dedicated runtime installation instead of npx. Install the latest runtime on first Add/Edit when missing; reuse installed versions with update prompts when the setup package is newer. Runtime converts existing standard entries together, preserving connection values, custom commands and external edits; linked development packages are protected.

- Clarify Sync choices with numbered AKMS/service versions, highlighted differences, wrapped values, and explicit apply destinations.

- Separate terminal menu, comparison and result screens; wait for acknowledgement before returning, while keeping piped commands unchanged.

- Keep all configuration menus visible; Add requires at least one registered AI service.
- Summarize registration/sync results, show only differing fields during review, and distinguish pending imports from shared settings conflicts.

### Changed

- Discover earlier client settings before registration, merge matching sync copies on Apply, and preserve differing versions for review.
- Add standalone `register` and `sync` commands and a persistent shared connection catalog. Save once to apply a connection to all registered AI services without installing `@akms/mcp`.
- Import existing client entries with explicit conflict choices; preserve external edits, retry partial failures and retain old names until renames succeed. Honor `CODEX_HOME`.

## 0.2.1 — 2026-10-19

### Documentation

- Add a minimum key-based connection example to README and clarify that host/user alone require an available authenticated SSH agent; document password alternatives and Windows launch settings.
- Make the jump-host/proxy example a complete JSON client configuration.

## 0.2.0 — 2026-10-19

### Changed

- Align the package, CLI and MCP server versions with the 0.2.0 MCP release family. Retain lazy SSH runtime loading and the existing command/path guard API used by WSL.

## 0.1.9 — 2026-10-19

### Changed

- Load SSH and its crypto runtime on the first connection instead of during idle MCP startup or local configuration work. Direct, proxy and jump-host routes share the loaded client constructor.
- Preserve shared connection attempts and reject a connection closed while the module was loading, before opening a proxy or network transport.
- Document idle-memory behavior and direct Node launch as an alternative to a persistent npm wrapper.

## 0.1.8 — 2026-10-19

### Added

- Add **Copy to another client** to each saved entry's config menu. Choose Claude Code,
  Codex, Claude Desktop or Cursor to copy its name, command, arguments and complete
  environment without changing the source or switching the current client.
- Ask before overwriting any same-name destination entry, including another package or
  HTTP transport. The default is No; Esc returns to the destination picker.

### Fixed

- Validate complete TOML before and after edits. Recognize inline/dotted server names,
  quoted keys and multiline values; refuse layouts that cannot be edited without
  changing unrelated settings. Preserve all string environment values when copying.
- Write JSON and TOML configs through a flushed temporary file and a single rename.
  Partial writes and failed commits keep the original; concurrent changes observed
  before committing abort the save. New config files use owner-only permissions.
- Detect destination names even when the entry cannot be listed as a stdio server.
  Reject malformed JSON server maps instead of replacing their contents.
- Replace the complete destination Codex server table when copying, removing stale
  transport options while keeping unrelated settings. Ordinary edits still preserve
  hand-written options.
- Restore the complete previous Claude Code entry if its replacement fails, and report
  recovery failures accurately. Missing-CLI messages no longer print credentials.

### Documentation

- Document the copy menu, overwrite confirmation and copied fields in the README.

### Verification

- Cover cross-client copying, name conflicts, cancellation, EOF, unreadable destinations,
  source preservation, TOML replacement and Claude Code CLI rollback.
- Reproduce multiline-string corruption, missed inline-name collisions, lost env keys,
  partial disk writes, failed renames and concurrent file changes.

## 0.1.7 — 2026-10-19

### Fixed

- Keep connection check results visible in interactive `config` until Enter is pressed,
  instead of immediately redrawing the menu and scrolling the report out of view.
  Esc goes back and Ctrl+C exits; scripted input needs no additional answer.

### Added

- Animate checks in `config` and `--check` with a spinner and elapsed time for each phase:
  SSH preparation, the jump host or proxy (when configured), and the target handshake and authentication.
  Completed phases remain visible with success or failure markers and colors.
- Fit progress lines to the terminal width, use ASCII on legacy Windows consoles, and
  respect `NO_COLOR`. Redirected output and `TERM=dumb` keep plain reports.

### Documentation

- Include `CHANGELOG.md` in the npm package and document the check display in the README.

### Library API

- `SshConnection.connect(onProgress?)` can report the `transport` and `host` phases of a new connection attempt.

### Verification

- Cover report pauses, cancellation, progress timing and cleanup, narrow terminals, and
  phase transitions on successful and failed checks.

## 0.1.6 — 2026-10-13

### Fixed

- Never stay behind when the MCP client dies. The first log line written after stdin ends goes to
  a stderr nobody reads; that EPIPE is now absorbed once and logging stops for good, instead of
  being logged again (the loop that kept `@akms/mcp-db` 0.1.1 alive at 100% CPU). Shutdown also
  has a 5 s deadline (`SHUTDOWN_DEADLINE_MS`) after which the process exits regardless.
- Keep the server running through an uncaught exception or unhandled rejection raised by one
  session instead of taking every tool of the client down; both are logged.

### Changed

- The `mcp server ready on stdio` log line carries the process `pid`.

### Verification

- Add `tests/cli-shutdown.test.ts`: starts the server through `cmd /c` the way Claude Code does
  on Windows, completes the handshake, lets the client die, and expects the server gone within 5 s.

## 0.1.5 — 2026-10-13

### Changed

- **Breaking:** Use `akms-mcp-ssh config` as the only configuration command. The former
  `setup` command now exits with code 1 and a reminder to use `config`.
- Align CLI help, usage examples and developer documentation with `config`.

### Verification

- Add CLI regression tests for help, `config --target codex`, rejecting `setup`, and
  the `--check` guidance when no host is configured. Tests use temporary client settings.

## 0.1.4 — 2026-10-13

### Documentation

- Expand the `setup` guide with keyboard controls, Esc behavior, the legacy `config`
  alias, and reconnecting the MCP client after saving.
- Document release version synchronization across the package files and `SERVER_VERSION`,
  plus tests, build, CLI smoke checks and package inspection before publishing.
- Clarify the test suite's local network requirements and its coverage of form navigation
  and text editing. Runtime behavior is unchanged.

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
