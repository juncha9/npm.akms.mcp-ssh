# Development

Working on `@akms/mcp-ssh` itself. For installing and configuring it, see [README.md](README.md).

## 🧑‍💻 Commands

```bash
npm install
npm run dev             # tsx src/cli.ts — run the server from source
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
│   ├── ssh/     ssh2 connection, session manager, SFTP ops
│   └── tools/   MCP tool registration, output formatting
├── server.ts    createSshMcpServer()
├── cli.ts       bin entry (stdio transport, --check)
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

## 🧪 Testing

350+ tests, no network access required.

| File | Covers |
|---|---|
| `command-guard.test.ts` | Segment splitting, binary resolution, per-policy verdicts |
| `guard-bypass.test.ts` | Regression suite — every evasion found in review |
| `path-guard.test.ts` | Remote allow-list, traversal, local credential rules |
| `host-profile.test.ts` | `SSH_*` mapping, defaults, malformed values, secret masking |
| `logger.test.ts` | Level resolution, secret masking |
| `remote-command.test.ts` | Command wrapping, cwd marker, truncation |
| `exec-integration.test.ts` | **Live ssh2 server** — exit codes, UTF-8, timeouts, host keys, stdin EOF |
| `sftp-integration.test.ts` | **Live SFTP subsystem** — listings, partial reads, transfers |
| `tool-integration.test.ts` | **MCP client ↔ server** over an in-memory transport |

Two integration styles matter here:

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

```bash
npm run build
npm pack --dry-run   # confirm lib/, README.md, LICENSE.md
npm publish
```

`files` in package.json controls the tarball — source, tests and this document are excluded.
