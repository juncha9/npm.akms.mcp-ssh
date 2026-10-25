# @akms/mcp-ssh

> 🔒 Internal use only — built for our organization's services.

MCP server that lets an AI agent run shell commands and transfer files on a remote host over SSH.

The host is **pre-registered** in the server's own environment; the agent never receives a hostname, key or password as an argument, and no tool takes one. Every command and path is screened against the guard policy before anything reaches the network.

Use **session server mode** to share one process among this kind's connections in each client session. Each connection keeps its own target, credentials and policy; its tool names carry the connection prefix. The environment-based examples below describe individual mode. See [Session server mode](#session-server-mode).

## 📦 Installation

Requires Node.js 18 or later.

```bash
npm install -g @akms/mcp-ssh@latest   # installs the `akms-mcp-ssh` command
akms-mcp-ssh --help
akms-mcp-ssh --version        # show the installed version
```

## Minimum working configuration

Install the server from **Runtime** before using these manual examples. On Windows its script is `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime/node_modules/@akms/mcp-ssh/lib/cli.js`; on macOS/Linux insert `lib/` before `node_modules`. Replace the placeholder below with that absolute path. Use the Node executable from `node -p "process.execPath"` as `command`. The `config` command writes both paths for you.

For a direct SSH connection using a private key, use this MCP client entry. Replace the host, user and key path with your own. The SSH server must be reachable on port `22`, and the matching public key must already be authorized for that user.

```json
{
    "mcpServers": {
        "ssh": {
            "command": "node",
            "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-ssh/lib/cli.js"],
            "env": {
                "SSH_HOST": "ssh.example.com",
                "SSH_USER": "deploy",
                "SSH_KEY": "~/.ssh/id_ed25519"
            }
        }
    }
}
```

`SSH_HOST` and `SSH_USER` are required. The example also supplies authentication explicitly: `SSH_KEY` must point to an existing private key file; add `SSH_PASSPHRASE` if it is encrypted. For password authentication, replace `SSH_KEY` with `SSH_PASSWORD`. Omit both only when the MCP process can access an SSH agent with an authorized key (`SSH_AUTH_SOCK`, or the OpenSSH agent on Windows). No default key file or `~/.ssh/config` is loaded automatically.

`SSH_PORT` defaults to `22`; jump-host and proxy settings are optional. Writes are allowed by default; add `"SSH_READONLY": "true"` for a read-only entry.

The JSON example fits an MCP client's `mcpServers` configuration, such as a project `.mcp.json` or Cursor's `mcp.json`. The direct Node command also works on Windows. For Codex TOML, open Register from `akms-mcp-ssh config --target codex` (or choose another client below).

## ⚙️ MCP client setup

Register the AI services you use once, then manage connections in one shared list. **This package works independently; installing or running `@akms/mcp` is optional.**

```sh
akms-mcp-ssh register   # toggle services, then Apply registration
akms-mcp-ssh config     # add, edit, check, print or remove connections
akms-mcp-ssh sync       # review differences and retry pending changes
```

### AKMS runtime and existing connections

Managed connections start Node directly using a dedicated installation at `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`. This directory is independent of Node version managers. The setup CLI may be installed globally as above or opened once with `npx -y @akms/mcp-ssh@latest config`; it is separate from the server runtime saved in client settings.

Before Add or a standard-launch Edit, setup installs a missing runtime with `npm install --global --prefix "<AKMS runtime directory>" --prefer-online --no-fund --no-audit @akms/mcp-ssh@latest`. If the installed version is older than this setup package, it offers an update (default Yes); declining continues with the installed version. Linked development packages skip this prompt. Host-key saves for standard launches also check the runtime before writing. Custom launch commands keep their existing command and require no managed-runtime installation. If an update fails but an installed runtime is still usable, setup reports the error and continues with that version. Servers do not invoke npm or query updates when AI clients connect.

To migrate existing entries, open `akms-mcp-ssh config`, choose **Runtime**, install the runtime if needed, then choose **Use for existing connections**. Both legacy npx entries and direct paths in ordinary global installations can be converted. Review and apply the list, then **restart or reconnect the AI clients** to replace running processes. Connection values and credentials stay intact; custom commands and external client edits are preserved for individual review. Register/import legacy entries first if they are missing from the shared list. Version-pinned npx entries switch to the installed version shown in the preview.

**Runtime > Update runtime installation** explicitly installs the latest release into this same directory. The Node executable keeps its existing alias path, allowing nvm-windows to switch Node versions while the package path stays fixed. If the Node command path or `AKMS_MCP_HOME` moves, reapply current paths from Runtime. Removing the runtime directory breaks entries that use it.

For development, build the checkout and link it with `npm install -g --prefix "<AKMS runtime directory>" "<checkout path>"`. Linked packages retain the runtime alias path; automatic updates do not overwrite the checkout link. See [README_DEV.md](README_DEV.md). `@akms/mcp` remains optional.

`config` always shows the connection menu, including Add, Register, Sync, Import and Runtime. With no registered services, Add displays a message asking you to open Register and returns to the menu without opening a form or changing settings. Claude Code, Codex, Claude Desktop and Cursor are supported; Enter toggles each service and Apply saves the selection. `--target codex` preselects Codex in Register; it does not restrict subsequent saves to Codex.

On an interactive terminal, connection menus, registration and comparisons use separate screens. Results and errors stay visible until Enter or Esc; returning to the menu shows current services and any connections needing attention. Piped commands keep plain output and need no extra answers. Sync labels the saved AKMS version and the current service version separately. Numbered choices show which service receives a value or whether it becomes the AKMS value for all registered services. Long values wrap, changed text is highlighted, and confirmation names the destinations.

Service selection is shared across the AKMS packages. Every saved connection is applied to all registered services, and a newly registered service receives existing shared connections. Unregistering removes only entries managed by AKMS from that service and retains the shared catalog. Restart or reconnect the MCP client to load changed settings.

### Startup checks and updates

After saving a changed connection, applying Runtime launch commands, or updating from **Updates**, setup starts each distinct saved command once without shell interpolation. It sends MCP `initialize` and `tools/list`, then closes stdin; it does not invoke database, SSH, WSL or S3 tools. The check takes at most about 10 seconds per entry, plus bounded process cleanup. Results show the server version and tool count, or the exit code and masked stderr tail. Standard runtime script paths and spawn command paths stay visible for diagnosis. Session checks also verify a tool-name prefix for every saved connection. A failed check keeps the saved settings: fix it before restarting or reconnecting AI clients. Identical command/arguments/environment values share one check.

Open **Updates** in the launcher or any package config menu to see installed and latest published runtime versions. Version lookup runs only when this screen opens or **Refresh versions** is chosen, with a short timeout; offline results show **Unavailable**. Update one runtime or all installed runtimes with newer releases; missing runtimes can be installed individually. Development links are displayed but never updated, and WSL is listed only on Windows. Updates use the same dedicated AKMS runtime directory and check that kind's saved connections afterward. Reconnect your AI clients to use the new runtime. The helper itself is not updated here.

Register confirmation defaults to **No** when deselecting a previously registered service; otherwise it defaults to **Yes**.

### Session server mode

New catalogs start in version 2 with session mode enabled. Register your AI services, then add connections; setup creates each kind's session entry automatically. Existing version 1 catalogs keep individual mode until you approve **Migrate registry** or a per-kind **Runtime > Switch to session server** conversion (default No). Register/import their existing connections first. Each registered AI service gets one `akms_db`, `akms_ssh`, `akms_wsl` or `akms_s3` entry for that kind, running Node directly with `--catalog`. The helper package is optional. A client session still owns its own stdio process; connections of the same kind share that process.

The server reads its connections from the shared catalog at startup. Tools include the connection name, for example `production__db_query`; their arguments stay unchanged. Add/Edit/Remove updates the catalog; reconnect your clients to load changes. Removing the last connection removes the session entry. An invalid connection is excluded while valid ones remain available; `<kind>_catalog_status` reports the loaded/excluded names without credentials. No database, SSH, WSL or S3 connection opens just to list tools.

Converting an existing version 1 catalog upgrades it to version 2 and keeps the previous revision. Older setup packages stop without modifying version 2. New kinds in a new catalog also default to sessions; each kind's explicit rollback choice is retained. AKMS removes managed individual entries only after verifying the session entry; external edits stay for **Sync** review. Custom launch commands are retained in the catalog for rollback but are not executed in session mode.

**Runtime > Switch back to per-connection entries** previews and restores the saved individual entries, including their credentials and launch commands. It removes the session entry after the replacements are verified. The registry stays version 2. **Reapply session launch command** updates paths after moving Node or the runtime. Restart/reconnect clients after either change.

Connection names use ASCII letters, digits, underscores or hyphens: DB up to 35 characters, SSH/WSL 30, S3 37. The four `akms_<kind>` names are reserved. These limits keep client-prefixed tool names within 64 characters; rename longer legacy entries before conversion.

### Migrate an older registry

When a version 1 registry or a version 2 registry without a default-mode marker is opened, the helper and each config menu show **Registry update available** and **Migrate registry**. Select it to review the ordered format steps, every kind's current layout, per-service additions/removals, and settings kept for Sync. Approval defaults to **No**.

Migration upgrades v1 to v2, records `defaultMode: "catalog"`, and converts individual kinds through the existing session conversion rules. Kinds explicitly switched back to individual entries keep that choice. Already bundled kinds keep their launch commands; an unmarked v2 containing only bundles receives the marker without client-file changes. Missing runtimes leave existing entries in place for **Runtime** installation and **Sync**. Startup checks verify the affected session tools after approval.

One `registry.previous.json` revision covers the whole migration. Repeating migration on a current registry does nothing. Runtime still offers per-kind conversion and rollback. **Runtime > Use individual entries for new kinds** turns the future-kind default off, and **Start new kinds as session servers** turns it back on; existing kinds retain their modes. The explicit `individual` default is also current format, so turning it off does not trigger another migration notice.

### Catalog security

The shared catalog is `~/.akms/mcp/registry.json`, or `$AKMS_MCP_HOME/registry.json`. It contains complete connection settings, including passwords and secret values **in plaintext**. In individual mode these values also appear in AI client entries. After successful session-mode conversion and resolution of any retained legacy entries, the catalog is the only active location for that kind's connection credentials; one previous-revision copy also contains them. SSH secrets include SSH_PASSWORD, SSH_PASSPHRASE, SSH_JUMP_PASSWORD and SSH_JUMP_PASSPHRASE. SSH private-key settings store file paths, not the key files themselves.

On POSIX, new catalog files request mode `0600` and new catalog directories `0700`; existing permissions are not tightened. Windows uses inherited parent-directory ACLs (normally the user profile), not POSIX owner/group modes. Check access permissions when choosing a custom location.

Keep both catalog files private: do not commit it, share it, copy it to another person or PC, paste its contents into chats/issues/AI conversations, or ask an AI agent to print it. Exclude it from cloud sync and shared backups, or protect those copies. Prefer SSH key authentication over passwords where possible. If exposed, change the affected passwords or rotate the affected keys/tokens, then update the connections through `config`.

SSH blocks local uploads from and downloads into `.akms/mcp`. A custom `AKMS_MCP_HOME` outside that path is not protected as a whole: its `registry.json` and `registry.previous.json` are additionally blocked when the SSH process has that environment variable. Remote SSH paths have no catalog-specific block. WSL protects these paths through `/mnt/<drive>/`; native Linux paths have no catalog-specific block, and local Windows transfers depend on the installed SSH guard. The locked SSH 0.1.9 dependency does not block the catalog in those local transfers. Do not rely on these guards to keep the file private.

Each successful catalog-changing operation atomically keeps one previous revision as **`registry.previous.json`** in the same directory. Internal application bookkeeping does not replace that pre-operation revision, and a no-op Sync leaves it unchanged. The copy requests the catalog's existing file permissions; Windows uses inherited ACLs. This is one revision, not a history.

To recover, close configuration commands, preserve the current file if needed, and copy `registry.previous.json` over `registry.json` in that directory. Then reopen setup, review **Sync**, and reconnect clients. Recovery does not automatically revert client files.

A running session keeps its startup snapshot. If `registry.json` is missing or invalid, a newly started session exposes only its status tool; its empty client entry cannot reconstruct credentials through Import. Restore the previous revision or enter the connections again. Individual mode still uses each entry's environment, so its existing client entries keep working and can be imported after registering services again.

Each standalone package manages this versioned file directly and does not call the optional helper.

Register shows existing AKMS entry counts even before registration. Applying registration automatically imports existing connections whose versions match, merging identical copies into one shared item. In session mode, it replaces owned individual entries after verifying the session launch. If a runtime is missing, the existing entries stay in place: install it from Runtime, then run Sync. Differing versions remain intact for review. Results summarize completed connections and list only items needing attention. The comparison shows changed fields, labels description-only differences, and keeps secrets hidden. Use **Import existing connections** to review differences later or import all remaining matching entries together. When versions differ, review the masked settings and choose which version to apply, or give the imported connection another name to keep both. The menu shows per-connection application counts. Failed writes keep the saved values and successful service updates; **Sync** retries pending changes and offers explicit choices for external edits. Unrelated or conflicting unmanaged entries are preserved.

Codex configs are validated before and after editing. Inline/dotted server definitions
are recognized, but automatic edits require the `[mcp_servers.<name>]` table layout;
unsupported edits are rejected without changing the file. JSON and TOML saves use a
temporary file so a failed write or commit preserves the previous config.

On a terminal, checks in `config` and `--check` show animated progress, elapsed time and
completed phases. After a check in `config`, **press Enter to continue**; Esc goes back and
Ctrl+C exits. Redirected output stays plain and scripted input needs no extra answer.
Release notes are in [CHANGELOG.md](CHANGELOG.md).

| Client | Config file | How it is written |
|---|---|---|
| Claude Code | `~/.claude.json` (user scope) | through `claude mcp add-json … -s user`, never by editing the file |
| Codex | `$CODEX_HOME/config.toml` (defaults to `~/.codex/config.toml`) | only the `[mcp_servers.<name>]` tables are rewritten; keys you added to them stay |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers.<name>` is set, every other key kept |
| Cursor | `~/.cursor/mcp.json` | same |

Only entries that launch this package are listed for management. An edit keeps every `SSH_*` variable the wizard does not ask about (timeouts, deny patterns, `SSH_CWD`, …). **Print** shows an entry as JSON, as a Codex TOML table and as a `claude mcp add-json` line, for when pasting is easier. Entries use the absolute Node executable and the script in the AKMS runtime directory on every platform.

**Or by hand — one server entry per host** — plain `SSH_*` variables, no separate server-side config file, no JSON inside JSON. Claude Code reads `.mcp.json` in the project or `~/.claude.json` globally; Claude Desktop takes the same block inside `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "ssh-prod": {
            "command": "node",
            "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-ssh/lib/cli.js"],
            "env": {
                "SSH_HOST": "10.0.0.5", "SSH_USER": "deploy", "SSH_KEY": "~/.ssh/id_ed25519",
                "SSH_READONLY": "true", "SSH_ALLOWED_PATHS": "/var/log,/opt/app"
            }
        }
    }
}
```

`SSH_HOST` + `SSH_USER` is sufficient only when an SSH agent with an authorized key is available; otherwise also provide a key path or password as shown in [Minimum working configuration](#minimum-working-configuration). The **private key stays a file on disk** — only its path goes in the config. Because each server fronts one host, the agent never names it: `ssh_exec({ command: "df -h" })` is a complete call. The server name (`ssh-prod`) is what the agent sees in its tool list, so name it after the host.

The server speaks MCP over **stdio**: stdout carries the JSON-RPC stream and all logging goes to stderr. Running it by hand in a terminal only prints the startup line and waits. When the client goes away — stdin ends, or the process is simply gone — the server closes its sessions and exits within a few seconds on its own; a stderr nobody reads is never a reason to stay. Its log says `mcp server ready on stdio` with its `pid`, for when one has to be found among a client's processes.

## 🗂️ Host configuration

Every setting is an environment variable in this server's own entry. There is no config file and no JSON — which is also why "what is this server allowed to do" is answerable by reading the entry above, with no second place to check.

### Connection

| `SSH_*` variable | Description |
|---|---|
| `SSH_HOST` ✅ | Hostname or IP |
| `SSH_USER` ✅ | Login user |
| `SSH_PORT` | Default `22` |
| `SSH_KEY` | **Path** to a private key file, `~` expanded |
| `SSH_PASSPHRASE` | Key passphrase |
| `SSH_PASSWORD` | Password auth, when no key is used |
| `SSH_HOST_KEY` | Pin the server's host key, `SHA256:…`; a mismatch aborts the connection |
| `SSH_NAME` | Alias shown to the agent; defaults to the hostname |
| `SSH_DESCRIPTION` | Shown to the agent — say what the host is for |
| `SSH_CWD` | Directory new sessions start in |
| `SSH_PROXY_COMMAND` | Command whose stdin/stdout carry the SSH stream — OpenSSH's `ProxyCommand`. `%h` / `%p` / `%r` expand to the first hop's host, port and user, `%%` to a literal `%` |
| `SSH_JUMP_HOST` | Jump host the target is reached through — OpenSSH's `ProxyJump` / `-J` |
| `SSH_JUMP_PORT` | Default `22` |
| `SSH_JUMP_USER` | Defaults to `SSH_USER` |
| `SSH_JUMP_KEY` | **Path** to the jump host's private key; defaults to `SSH_KEY` (and then shares `SSH_PASSPHRASE`) |
| `SSH_JUMP_PASSPHRASE` | Passphrase for `SSH_JUMP_KEY` |
| `SSH_JUMP_PASSWORD` | Password auth on the jump host |
| `SSH_JUMP_HOST_KEY` | Pin the jump host's key, `SHA256:…` |

Authentication is tried in this order: **private key by path** (with `SSH_PASSPHRASE` if encrypted), **password**, then the **SSH agent** when neither is set (`SSH_AUTH_SOCK`, or the OpenSSH named pipe on Windows). A key path that doesn't exist is reported at startup, not at first connection.

### Through a jump host or a proxy command

`~/.ssh/config` is **not** read — the server never shells out to `ssh` — so a `ProxyJump` or `ProxyCommand` that works on the command line has to be stated in the entry. Both OpenSSH shapes are available, and they compose:

```json
{
    "mcpServers": {
        "ssh-dev": {
            "command": "node", "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-ssh/lib/cli.js"],
            "env": {
                "SSH_HOST": "10.0.16.12", "SSH_USER": "ubuntu", "SSH_KEY": "~/.ssh/id_ed25519",
                "SSH_JUMP_HOST": "dev-ak-ssh.example.com",
                "SSH_PROXY_COMMAND": "cloudflared access ssh --hostname %h"
            }
        }
    }
}
```

- **`SSH_JUMP_HOST`** connects to the jump host first and opens a forwarded TCP channel to `SSH_HOST:SSH_PORT`, which the target handshake then runs over — exactly what `ssh -J` does. The jump host authenticates in the same order from `SSH_JUMP_*` — user and key fall back to the target's, the password does not — and its host key can be pinned with `SSH_JUMP_HOST_KEY`. Any `SSH_JUMP_*` set without `SSH_JUMP_HOST` fails startup rather than quietly connecting straight to the target.
- **`SSH_PROXY_COMMAND`** starts the command through the shell and talks SSH over its stdin/stdout, as `ProxyCommand` does — `cloudflared access ssh --hostname %h`, `ssh -W %h:%p bastion`, `nc %h %p`. It carries the **first hop**: the jump host when one is set, otherwise the target. The entry above therefore reads "cloudflared to the jump host, then forward to 10.0.16.12".
- Either alone works too: a jump host reachable directly needs only `SSH_JUMP_HOST`; a host behind a Cloudflare Access tunnel needs only `SSH_PROXY_COMMAND`.

The proxy process lives exactly as long as the connection it carries and is killed with it (the whole process tree on Windows). Its stderr goes to the log at `warn`, which is where a `cloudflared` login prompt or a refused tunnel shows up. Log in once with `cloudflared access login <url>` before wiring the entry up: the server cannot open a browser for you, and `SSH_CONNECT_TIMEOUT_MS` expires first.

`--check` prints the route and both host key fingerprints, so the jump host's key can be pinned the same way:

```
Checking 10.0.16.12  →  ubuntu@10.0.16.12:22
  via proxy command: cloudflared access ssh --hostname %h
  via jump host: ubuntu@dev-ak-ssh.example.com:22

  OK      ubuntu@10.0.16.12:22  (key /home/me/.ssh/id_ed25519, 1840ms)
          host key SHA256:9x2K…  (not pinned — set SSH_HOST_KEY to it to detect a changed key)
          jump host key SHA256:Qm7d…  (not pinned — set SSH_JUMP_HOST_KEY to it to detect a changed key)
```

### Policy

| `SSH_*` variable | Default | Effect |
|---|---|---|
| `SSH_READONLY` | `false` | Rejects write commands, output redirection, package installs, uploads and remote writes |
| `SSH_ALLOW_SUDO` | `true` | When false, rejects `sudo` / `su` / `doas` / `pkexec` / `runuser` / `chroot` |
| `SSH_ALLOW_COMMANDS` | *(none)* | When set, only these binaries may run — the strictest lever available (`pwd` is added automatically so sessions can open) |
| `SSH_DENY_PATTERNS` | *(none)* | Extra regex sources, compiled at startup and tested per command segment |
| `SSH_ALLOWED_PATHS` | *(none)* | When set, the file tools accept only absolute paths inside these prefixes |
| `SSH_EXEC_TIMEOUT_MS` | `60000` | Per-command wall clock; the channel is closed when it elapses |
| `SSH_CONNECT_TIMEOUT_MS` | `20000` | TCP + handshake limit |
| `SSH_MAX_OUTPUT` | `100000` | stdout and stderr are each truncated past this |
| `SSH_MAX_READ_BYTES` | `200000` | `ssh_read_file` ceiling |

**Defaults are permissive on purpose.** An unconfigured host allows ordinary administration — installs, service restarts, sudo, interpreters, deployments — because a guard that blocks real work gets switched off wholesale instead of tuned. Restriction is opt-in.

Lists are comma-separated and booleans also accept `1`/`0`, `yes`/`no`, `on`/`off`. A malformed value fails startup rather than being ignored — `SSH_READONLY=ture` is an error, not "not read-only" — and `SSH_DENY_PATTERNS` is compiled at startup, so a typo'd regex can't be silently absent at the moment it matters. A missing `SSH_HOST` is not fatal: the server starts with nothing registered and the tools say so.

### Several hosts

Add a server entry per host. Each one carries its own connection and its own policy, right where you read it, and the agent picks a host by choosing a tool — there is no host argument to get wrong:

```json
{
    "mcpServers": {
        "ssh-prod": {
            "command": "node", "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-ssh/lib/cli.js"],
            "env": { "SSH_HOST": "10.0.0.5", "SSH_USER": "deploy", "SSH_READONLY": "true" }
        },
        "ssh-dev": {
            "command": "node", "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-ssh/lib/cli.js"],
            "env": { "SSH_HOST": "192.168.0.10", "SSH_USER": "ubuntu" }
        }
    }
}
```

### Check it before wiring it up

```bash
akms-mcp-ssh --check
```

Connects to the configured host and reports what happened — exit code 0 when it is reachable. Otherwise a setup mistake is indistinguishable from a policy rejection when the agent tries something. Warnings still print during the check (a missing key file, the proxy command's stderr); add `SSH_MCP_LOG_LEVEL=debug` to see the handshake.

```
Checking prod-web  →  deploy@10.0.0.5:22

  OK      deploy@10.0.0.5:22  (key /home/me/.ssh/id_ed25519, 412ms)
          host key SHA256:9x2K…  (not pinned — set SSH_HOST_KEY to it to detect a changed key)
```

That fingerprint is the same string `ssh-keyscan -t ed25519 host | ssh-keygen -lf -` gives — copy it into `SSH_HOST_KEY` to pin it. **An unpinned host accepts whatever key the server presents**: fine on a LAN, worth pinning across the internet, and the thing that tells you a host was rebuilt.

## 🧰 Tools

| Tool | Purpose |
|---|---|
| `ssh_list_hosts` | The configured host, its route and its guard policy. No credentials |
| `ssh_connect` | Open a reusable session, returns a session id |
| `ssh_disconnect` | Close a session |
| `ssh_list_sessions` | Open sessions with cwd, command count and idle time |
| `ssh_exec` | Run a command; returns stdout, stderr, exit code, duration |
| `ssh_list_dir` | SFTP directory listing (type, mode, size, mtime) |
| `ssh_read_file` | Read a remote text file, truncated to the byte ceiling |
| `ssh_write_file` | Write or append UTF-8 text over SFTP |
| `ssh_upload` | Local → remote file transfer |
| `ssh_download` | Remote → local file transfer |

### One-off vs session

No tool takes a host argument — the host is the one in this server's env block, so the agent can't name a machine. The only choice is whether to reuse a connection:

- **Omit `session`** — a fresh connection is opened and closed around the single call. Simple, but pays a handshake each time and keeps no state. Capped at 32 concurrent.
- **Pass `session`** (an id from `ssh_connect`) — reuses the connection and **remembers the working directory**, so `cd /opt/app` in one `ssh_exec` still applies to the next. Passing `cwd` alongside `session` moves the session there. Capped at 32, reaped after 15 minutes idle but never mid-operation, so a long build or a large transfer is safe. A dropped connection is reported on the next call rather than silently reconnected into a fresh login shell.

A non-zero exit code comes back as ordinary output with stdout and stderr for the agent to read; only a genuine failure (connection refused, guard rejection) is flagged as a tool error.

### Commands run without a terminal

Remote stdin is closed immediately, so anything that waits for input fails fast instead of hanging until the timeout:

- `sudo` on a host without `NOPASSWD` fails with `sudo: a password is required` in milliseconds. Either configure `NOPASSWD` for the commands the agent needs, or use `sudo -n` and expect the failure.
- Confirmation prompts need their non-interactive flag — `apt-get install -y`, `rm -f`, `ssh-keygen -q -N ''`.
- Full-screen tools (`top`, `vi`, `htop`) have no TTY. Use `top -bn1`, `ps aux`, and `ssh_write_file` instead of an editor.

A long job outliving its timeout keeps running remotely; start it with `nohup … &` or `tmux new -d` and poll the log.

## 🛡️ Guard policy

**The threat model is a mistaken agent, not an adversary.** An agent that means well can still type `rm -rf /` with a variable that expanded to nothing, or reboot the host it is currently working through. Those are what the guards stop. One that is *trying* to get around a text-based screen will succeed — a shell can express the same operation in unlimited ways, and chasing that is how a guard ends up blocking `awk` and getting turned off. So the layers are deliberately few:

| Layer | Scope | Examples |
|---|---|---|
| **Catastrophe** | Always, not configurable | `rm -rf /` (and `/etc`, `/home`, `~`, `//*`, `/tmp/x /`), `rm /etc/passwd`, `rm /boot/vmlinuz*`, `mkfs`, `dd of=/dev/sda`, `shutdown`, `reboot`, `chmod -R 777 /`, `find / -delete`, `crontab -r`, `iptables -F`, `--no-preserve-root`, fork bombs |
| `SSH_READONLY` | Opt-in | `rm`/`mv`/`cp`/`mkdir`/`tee`, package installs, editors, `ssh`/`scp`/`wget`, `sed -i`, `sort -o`, `find -delete`, `git push`, `systemctl restart`, `docker run`, `kubectl apply`, `tar -x`, `curl -o`, `> file` redirection |
| `SSH_ALLOW_SUDO=false` | Opt-in | any segment invoking `sudo`, `su`, `doas`, `pkexec`, `runuser`, `chroot` |
| `SSH_ALLOW_COMMANDS` / `SSH_DENY_PATTERNS` | Opt-in | whatever you list |
| Path guards | `SSH_ALLOWED_PATHS` (remote), built-in credential rules (local) | paths outside the allow-list; local credential and config files |
| `cwd` | Always | a working directory containing shell metacharacters |

Everything not in that table runs: installing packages, restarting services, editing configs, `curl … | sh`, deleting an application's own files, `sudo`. `SSH_READONLY` deliberately still allows interpreters (`python3 -c`, `node -e`), `awk`, database clients, `git log`, `docker logs` — a read-only host exists to be **inspected**, and log analysis needs those. A shell payload is screened either way, so `bash -c "rm x"` is caught by the `rm` rule.

Rules are enforced inside `SshConnection.exec` and the SFTP operations — the layer every command and path must pass through — so a new tool cannot forget to call the guard. A rejection returns the rule that fired, the offending segment, and the note that nothing was sent. The screening walkthrough is in [README_DEV.md](README_DEV.md#how-a-command-is-screened).

`SSH_ALLOWED_PATHS` binds the **file tools only**: `ssh_exec` can still read anything the remote account can, and `ssh_list_hosts` says so. Per-call `timeoutMs` and `maxBytes` are **clamps, not defaults** — they may lower the configured ceiling, never raise it.

### Local path protection

The file tools run with this server's own privileges on your machine, so `localPath` is guarded in both directions — but narrowly, covering **credentials** (`~/.ssh`, `authorized_keys`, private keys, `.pem`/`.key`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `.npmrc`, `.netrc`) and **files that define the guards** (`.claude*` / `.mcp.json` / `claude_desktop_config.json` — where this server's `SSH_*` variables live — plus autostart locations). `.env` uploads, `.bashrc` backups and cron fetches are normal deployment work and are allowed. Symlinks are resolved before matching, so a link into `~/.ssh` does not slip past.

## Memory and process lifetime

SSH and its crypto runtime load on the first connection instead of during idle MCP startup or local configuration work. The same loaded client supports direct, proxy and jump-host routes. Concurrent callers share the connection attempt, and disconnecting during module loading prevents a later transport from opening. The runtime stays loaded after first use; disconnecting a session closes its transport rather than unloading the module.

Individual mode starts one server process per configured connection in each client session. Session mode combines that kind's connections in one stdio process per client session. Both use the dedicated runtime directly, avoiding a resident npm/npx wrapper. Convert from Runtime and reconnect clients to load the new layout. Connections to remote services remain lazy.

Restart MCP connections after updating to apply the new code. Compare process counts and Windows Private Bytes separately from resident memory (RSS), including npm wrappers in the total.

## 📄 Logging

Everything goes to **stderr** (stdout is the MCP protocol channel). `SSH_MCP_LOG_LEVEL` picks the level — `silent` / `debug` / `info` / `warn` / `error`, default `info`. Guard rejections are logged at `warn` with the full command, and that log is the audit trail for what the agent tried; full command text is otherwise only logged at `debug`, while `password`, `passphrase`, `privateKey` and `token` meta keys are always masked.

## ⚠️ Security notes

**The real boundary is the remote account.** The guards stop mistakes; containment has to come from the host — give each server entry a dedicated unprivileged user rather than `root`, restrict its `sudoers` entries to the exact commands it needs, pair `SSH_READONLY=true` with filesystem permissions that agree with it, reach for `SSH_ALLOW_COMMANDS` on the strictest hosts, and back up anything you would miss.

- The MCP client entry names the host and may hold `SSH_PASSWORD` or `SSH_PASSPHRASE` (and their `SSH_JUMP_*` counterparts). Prefer a key file so only its *path* is stored, keep the entry out of version control, and `chmod 600` it — the shipped `.gitignore` already excludes `*.pem`, `id_rsa*` and `id_ed25519*`.
- **Anything the agent can reach, a prompt injection can reach.** Output from a remote host is untrusted input; a file the agent reads can contain instructions. With permissive defaults that matters more, not less — keep a production entry `SSH_READONLY=true` and let write access be a deliberate exception.
- The catastrophe rules are the *only* ones that hold regardless of configuration, and even they read the command as text. Treat them as a seatbelt, not a cage.
- Point this at hosts you are authorized to administer. This is an administration tool, not a scanner.
- Local paths are resolved against the machine running the server, so on Windows a POSIX-looking `/tmp/x` becomes `<current drive>\tmp\x`. Every transfer reply prints the resolved path — check it.

## 🧑‍💻 Development

Building on this server, embedding it as a library, or changing the guards — see [README_DEV.md](README_DEV.md).

## 📜 License

MIT — see [LICENSE.md](LICENSE.md).
