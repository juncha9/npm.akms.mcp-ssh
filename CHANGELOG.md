# Changelog

All notable changes to `@akms/mcp-ssh`. Dates are `YYYY-MM-DD`.

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
