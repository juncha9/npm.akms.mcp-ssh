# Development

## Release guard and package order

Run `npm run prepublishOnly` to inspect every publish prerequisite without publishing. `npm publish` runs the same `node scripts/release-guard.mjs` gate. It requires a clean `git status --porcelain`, a package version newer than the configured registry's `latest`, matching `SERVER_VERSION` (servers only), and five registration copies matching the DB baseline. Metadata uses a fresh temporary cache. Any lookup failure, including E404, or a missing `latest` tag blocks release. All five sibling checkouts are needed for release comparison; normal builds and installed packages do not need them.

The DB registration directory is the baseline. Run `node scripts/sync-registration.mjs` from the DB checkout after common changes. The launcher keeps its own adapters and its `prompter.ts` import is adjusted for `launcher/prompter`. Keep the five development-only `scripts/release-guard.mjs` copies identical.

Release in this order:

1. Publish `@akms/mcp-ssh` with AKMS registry protection first, after its tests, build, package inspection, reviewed commit and release gate pass.
2. Raise `@akms/mcp-wsl`'s SSH dependency minimum to that published protected release, remove ranges permitting SSH 0.1.9, and refresh its lockfile and local dependency. WSL's release gate calls the installed SSH guard against `.akms/mcp` reads and writes; the current SSH 0.1.9 must fail, regardless of the WSL version.
3. Validate and publish WSL, then the DB and S3 servers. Align each manifest, lockfile and `SERVER_VERSION`, synchronize registration, and commit reviewed release changes before running the gate.
4. Publish the optional `@akms/mcp` launcher last, once every child can be installed from npm.

The guard never commits, installs dependencies or publishes. `npm pack --dry-run` inspects contents without invoking this publish-only gate.

Working on `@akms/mcp-ssh` itself. For installing and configuring it, see [README.md](README.md).

## 🧑‍💻 Commands

```bash
npm install
npm run dev             # tsx src/cli.ts — run the server from source
npm run dev -- config    # open the host manager from source
npm run build           # tsc --noEmit + tsup (ESM + CJS + d.ts)
npm test                # vitest
npm run test:watch
npm run test:coverage
node lib/cli.js --check # connect to the configured host and report
```

Node 18+. The build emits both module formats plus declarations; `lib/cli.js` keeps its shebang and is the `akms-mcp-ssh` bin.

## 🗂️ Layout

```
src/
├── _defs/       constants, guard rule tables, env var names
├── _types/      config / ssh / guard types (compile-time only)
├── _libs/       stderr logger, text + path helpers
├── modules/
│   ├── config/  SSH_* readers, profile builder, credential-free summary
│   ├── guard/   command + path inspection, GuardRejectionError
│   ├── manage/  the `config` command: prompts, settings form, per-client config writers
│   ├── ssh/     ssh2 connection, session manager, SFTP ops
│   └── tools/   MCP tool registration, output formatting
├── server.ts    createSshMcpServer()
├── cli.ts       bin entry (stdio transport, --check, config)
└── index.ts     library entry
```

`_defs` holds runtime values, `_types` is erased at compile time — so `import type` from `_types` is guaranteed side-effect free. Both carry barrels; consumers import `@/_defs` and `@/_types`, never a specific file.

## 🏗️ Design decisions

### Guards live at the chokepoint, not in the tool handlers

`SshConnection.exec` screens its own command and the SFTP operations screen their own paths, rather than each tool remembering to call a guard first.

The earlier arrangement had exactly one call site for `inspectCommand`, and an unguarded one had already crept in — `ssh_connect`'s `pwd` probe. A new tool was one forgotten line away from shipping unscreened commands, with no compile error and no failing test. Now the guard cannot be skipped, because there is no path to the network that does not pass through it.

Consequence: the tool layer only *renders* rejections (`GuardRejectionError` → `formatGuardRejection`). It never decides them.

### How a command is screened

`inspectCommand` runs these in order. The README documents *what* each policy blocks; this is *how* the text is taken apart to decide.

1. **Canonicalize** — `\`+newline continuations are removed (as POSIX does) and `${IFS}` expands to a space. See the invariant below.
2. **Pipeline rules** — fork bombs.
3. **Nested commands** — `$(…)`, backticks and process substitution `<(…)` are each screened as their own command, recursively.
4. **Split into segments** on `;`, `&&`, `||`, `|`, `&` and newlines. Quoted text stays intact, so `echo "a; b"` is one segment.
5. **Per segment**, resolve the binary that actually runs by stepping past `FOO=bar` assignments, redirection tokens, shell keywords (`if`, `then`, `{`, `(`), wrapper binaries (`sudo`, `env`, `nohup`, `timeout`, `eval`, `busybox`, …), their numeric operands and their flag values — so `timeout 30 sudo rm -rf /` resolves to `rm`, not `30`, and `env -u PATH rm -rf /` resolves to `rm`, not `PATH`. The binary is reduced to its basename, so `/sbin/reboot` matches the same rule as `reboot`.
6. **Nested payloads** — a `-c "…"` string (including bundled forms like `bash -lc`) or a `--` argv tail is screened as its own command.

Steps 3–6 are why a policy list stays short: each one folds a family of spellings back onto the same rule, instead of the rule table growing an entry per spelling.

### The threat model is a mistaken agent

The guards stop `rm -rf /` typed by accident. They do not stop `python3 -c` or an encoded payload, and no amount of pattern-chasing changes that — a shell can express any operation in unlimited ways.

This is why the catastrophe list is short and everything else is opt-in. A guard that blocks `awk` gets switched off wholesale rather than tuned, which leaves less protection than a narrow one that stays on. Containment belongs to the remote account's permissions; see the README's guard section.

When adding a rule, ask: *does this stop a plausible mistake, or only an evasion?* Only the first is worth an entry.

### Validated text and executed text are the same string

`canonicalizeCommand` runs before screening, and its output is what reaches the remote shell. An earlier version folded `\`+newline to a space for inspection while sending the original, so the guard saw `r m -rf /` and the host ran `rm -rf /`. Any future normalization must keep this invariant.

### One host, from the environment, with no second source

There is one place a host can come from: the `SSH_*` variables in this server's own env block. No config file, no JSON, no home-directory lookup — so "which policy is in force" is answerable by reading the MCP client entry, and there is no precedence order to reason about.

That constraint reaches the tool surface too. With one host there is nothing to select, so no tool takes a host argument, and the model cannot name a machine even in principle. Fronting several hosts means several server entries, which keeps each one's policy visible where its connection is declared.

A malformed value aborts startup rather than being ignored: `SSH_READONLY=ture` throws instead of resolving to "not read-only", and `SSH_DENY_PATTERNS` is compiled at load so a typo'd regex cannot be silently absent at the moment it matters.

### Sessions serialize, one-off connections don't persist

`SshSession.runExclusive` serializes work on a session because `cwd` is a read-modify-write across a network round trip. Two concurrent calls would both read the old directory and the later one would write it back, silently undoing the other's `cd`.

A dropped connection is reported rather than re-dialled. Reconnecting hands back a fresh login shell — environment, sudo cache and background jobs gone — while the model still believes it holds the old one.

### A jump host or proxy command is a carrier, not a second connection

`SshConnection.connect` opens the carrier first — the proxy process, the jump client's forwarded channel, or the channel riding on the proxy — and hands it to ssh2 as `sock`. The target handshake is then the same code path as a direct TCP connection: one client, one `hostVerifier`, the same ready / error / close handling. The carrier is released from the target client's `close` handler, whichever side closed, so nothing has to remember to tear it down.

The proxy command runs through the shell, as OpenSSH's `ProxyCommand` does. On Windows that puts `cmd.exe` between us and the real process, so the transport kills the process tree (`taskkill /T`) rather than just the shell — otherwise `cloudflared` would outlive the connection it carried.

### `config` writes through whatever owns the file

The `config` command edits other programs' config files, so each target is written the least invasive way available. `~/.claude.json` is Claude Code's own state file, rewritten by the running process, so writes go through `claude mcp add-json` / `remove` and the file is only read. Codex's TOML is rewritten by section with no TOML dependency: only `[mcp_servers.<name>]` and its `.env` table are rebuilt, and every other line comes back byte for byte. Plain `mcpServers` JSON files are merged one key at a time, and a file that does not parse is never written.

The connection check feeds the entry about to be written through `loadHostProfile(env)` and the same report `--check` prints. A value the server would reject is therefore caught before it is written, and a host that passes the configuration check passes `--check`. Full rules and rationale are in [docs/design/setup-command.md](docs/design/setup-command.md).

### A dead stderr is never a reason to stay

When the MCP client dies, every pipe the server holds dies with it. stdin's EOF starts the shutdown, and
the first log line of that shutdown goes to a stderr nobody reads: on Windows the write fails
asynchronously with EPIPE as an `'error'` event on `process.stderr`. The logger owns one listener for
that event and drops every later line (`stderrBroken`), so the failure is never logged — logging it
was the loop that kept `@akms/mcp-db` 0.1.1 behind at 100% CPU, measured 2026-10-13 under Claude
Code's `cmd /c` launch. Here the exit used to win the race because `shutdown()` is synchronous; the
guard removes the race, the `uncaughtException` handler keeps one session's stray error from ending the
client's whole tool set, and `SHUTDOWN_DEADLINE_MS` (5 s) exits regardless of what the transport or a
gone peer still owes. `tests/cli-shutdown.test.ts` starts the server the way Claude Code does and
expects it gone within 5 s of the client's death.

## 🧪 Testing

The suite uses local fixtures and needs no external SSH hosts or services. Integration tests
listen on loopback sockets and start and stop local proxy processes; allow those in the test environment.

| File | Covers |
|---|---|
| `command-guard.test.ts` | Segment splitting, binary resolution, per-policy verdicts |
| `guard-bypass.test.ts` | Regression suite — every evasion found in review |
| `path-guard.test.ts` | Remote allow-list, traversal, local credential rules |
| `host-profile.test.ts` | `SSH_*` mapping, defaults, malformed values, secret masking, jump / proxy route variables |
| `logger.test.ts` | Level resolution, secret masking |
| `remote-command.test.ts` | Command wrapping, cwd marker, truncation |
| `exec-integration.test.ts` | **Live ssh2 server** — exit codes, UTF-8, timeouts, host keys, stdin EOF |
| `sftp-integration.test.ts` | **Live SFTP subsystem** — listings, partial reads, transfers |
| `route-integration.test.ts` | **Live jump host + proxy command** — a bastion `ssh2.Server` that forwards `direct-tcpip`, and `tests/_fixtures/tcp-relay.cjs` as a cross-platform `nc %h %p` |
| `tool-integration.test.ts` | **MCP client ↔ server** over an in-memory transport |
| `cli-command.test.ts` | CLI help, `config --target`, rejecting `setup`, and unconfigured `--check` guidance |
| `manage-entry.test.ts` | `config` answers ⇄ entry, carried variables, the `loadHostProfile(env)` contract |
| `manage-toml.test.ts` | Codex TOML: append, replace keeping hand-added keys, remove, CRLF |
| `manage-command.test.ts` | **The `config` UI end to end** — scripted stdin, a live `ssh2.Server`, a temp JSON config; Esc restores fields and reopens the write preview |
| `manage-prompter.test.ts` | Arrow-key lists, text editing, secret input and Esc on a simulated TTY; numbered choices and ESC-line fallback off one |
| `manage-cli-shim.test.ts` | Windows only — a JSON payload through npm's `.cmd` shim template, byte for byte |

Three integration styles matter here:

- `route-integration` stands up two servers — a target and a bastion that answers `direct-tcpip` with a real socket — so the jump path is the actual `forwardOut` channel, and the proxy path really spawns a process and speaks SSH over its pipes. Nothing is mocked below ssh2.
- `exec-integration` / `sftp-integration` stand up a real `ssh2.Server` in-process, so assertions are about the actual wire (`cd '/var/log'` really is sent; a multi-byte character really does survive a packet boundary). The SFTP one implements OPEN/READ/WRITE/READDIR/STAT over an in-memory filesystem.
- `tool-integration` connects an MCP `Client` to the server through `InMemoryTransport`. It is the only place proving the handlers *reach* the guards — deleting a guard call used to leave every other test green.

Shared fixtures are in `tests/_helpers.ts` (not a `*.test.ts`, so vitest skips it). Add policy fields there, not in each file.

When fixing a bug found by review, add its reproduction to `guard-bypass.test.ts` with a comment naming what used to happen.

## 📚 Embedding as a library

The server is exported, so it can run over a different transport — an HTTP host, or an in-memory pair for tests:

```typescript
import { createSshMcpServer } from "@akms/mcp-ssh";

// the host comes from the SSH_* variables in this process's environment
const instance = createSshMcpServer();
await instance.server.connect(myTransport);
// …
instance.shutdown();   // closes every open session
```

The pieces are individually importable — `loadHostProfile`, `inspectCommand`, `inspectRemotePath`, `SshConnection`, `SshSessionManager`, `registerAllTools`, `GuardRejectionError`.

Note that `withSftp` exposes ssh2's `SFTPWrapper` in its signature, so consumers of the types need `@types/ssh2` resolvable.

## 📦 Releasing

Version **0.1.5** removes the `setup` command; existing setup invocations must change to
`config`. The CLI regression suite verifies the transition using temporary client settings.

Keep the package version and runtime version in sync:

1. Bump `package.json` and both root version fields in `package-lock.json` together.
   `npm version patch --no-git-tag-version` does this for a patch release; use `minor` or
   `major` when appropriate.
2. Set `SERVER_VERSION` in `src/_defs/defaults.ts` to the same value. Both CLI `--version`
   and the MCP server handshake report this constant.
3. Add a dated entry to `CHANGELOG.md` and update the user and developer docs for the change.

Validate the release from the working tree:

```bash
npm test
npm run build
node lib/cli.js --version   # must match package.json
node lib/cli.js --help      # confirm the CLI starts and lists config
npm pack --dry-run          # inspect the version and packaged files
```

`files` in `package.json` controls the tarball: `lib/`, `README.md`, `CHANGELOG.md` and `LICENSE.md`, plus
the automatically included `package.json`. Source, tests and this document are excluded.
Once the release is ready, `npm publish` publishes it to the registry.

## Registration code

The local `src/modules/registration` copy is bundled into this package. It needs no launcher or sibling checkout at build or runtime. The sibling DB checkout maintains the shared files; its `node scripts/sync-registration.mjs` command updates development copies. Keep schema version 1 compatible across releases and test standalone registration before publishing.

## Link the development runtime

The server installation is independent of the active Node version: `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`. After building the checkout, use npm's global layout with this explicit prefix; a plain `npm link` in the default Node prefix is not discovered as the managed runtime.

From this checkout in PowerShell:

```powershell
npm run build
$akmsRuntime = if ($env:AKMS_MCP_HOME) { Join-Path $env:AKMS_MCP_HOME "runtime" } else { Join-Path $env:USERPROFILE ".akms/mcp/runtime" }
npm install --global --prefix $akmsRuntime .
node lib/cli.js config
```

For macOS/Linux, use `npm install --global --prefix "${AKMS_MCP_HOME:-$HOME/.akms/mcp}/runtime" "$PWD"` after building (supported by this package). The package is linked into the prefix without moving the source checkout. Runtime shows **linked development checkout**, hides Update and skips version-update prompts. Rebuild the source to change the running code, then reconnect AI clients. Use Runtime > Use for existing connections to migrate older npm/npx launch paths.

## Session-server compatibility

Setup reads registry versions 1 and 2. New catalogs start at version 2 with `defaultMode: "catalog"`; their first connection of each kind creates its session launch. Existing version 1 catalogs require the confirmed Runtime switch. Existing version 2 catalogs without `defaultMode` retain individual mode for kinds without explicit session state. Per-kind choices override the default, and rollback keeps version 2 so older setup cannot recreate individual entries. Server `--catalog` readers accept both versions without locks or writes. The common `catalog.ts` has no dependency on setup or the optional helper. Include it in the five-copy release comparison. `registration-session.test.ts` covers migration/rollback, backup failure, name budgets, external edits, replacement ordering and bundle startup coverage.

During active MCP development, build a disposable source copy and validate it before replacing live `lib` files. The normal build removes `lib`; running it beneath a connected MCP can break active sessions.

Registry migrations are ordered in `registry.ts`: `v1_to_v2`, then `catalog_default`. `needsMigration`, `planMigration`, and `applyMigration` support scripted review/application; the plan is rechecked under the normal lock. Session planning and state transitions are shared with `planSession`/`applySession`, while one outer mutation preserves the pre-migration backup. `setDefaultMode("individual")` and `setDefaultMode("catalog")` change only the future-kind default after migration. An explicit individual marker remains current format. `registration-migration.test.ts` covers migration, no-op repetition, backup, stale plans, external edits, missing runtimes, rollback preservation and menu approval. Include `migration-menu.ts` in common-file synchronization.
