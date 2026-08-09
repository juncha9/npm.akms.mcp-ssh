# @akms/mcp-ssh

> 🔒 Internal use only — built for our organization's services.

MCP server that lets an AI agent run shell commands and transfer files on a remote host over SSH.

The host is **pre-registered** in the server's own environment; the agent never receives a hostname, key or password as an argument, and no tool takes one. Every command and path is screened against the guard policy before anything reaches the network.

## 📦 Installation

```bash
npm install -g @akms/mcp-ssh   # installs the `akms-mcp-ssh` command
npx -y @akms/mcp-ssh --help    # or run it straight from the registry
```

## ⚙️ MCP client setup

**One server entry per host** — plain `SSH_*` variables, no config file, no JSON inside JSON. Claude Code reads `.mcp.json` in the project or `~/.claude.json` globally; Claude Desktop takes the same block inside `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "ssh-prod": {
            "command": "npx",
            "args": ["-y", "@akms/mcp-ssh"],
            "env": {
                "SSH_HOST": "10.0.0.5", "SSH_USER": "deploy", "SSH_KEY": "~/.ssh/id_ed25519",
                "SSH_READONLY": "true", "SSH_ALLOWED_PATHS": "/var/log,/opt/app"
            }
        }
    }
}
```

`SSH_HOST` + `SSH_USER` is the whole minimum, and the **private key stays a file on disk** — only its path goes in the config. Because each server fronts one host, the agent never names it: `ssh_exec({ command: "df -h" })` is a complete call. The server name (`ssh-prod`) is what the agent sees in its tool list, so name it after the host.

The server speaks MCP over **stdio**: stdout carries the JSON-RPC stream and all logging goes to stderr. Running it by hand in a terminal only prints the startup line and waits.

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

Authentication is tried in this order: **private key by path** (with `SSH_PASSPHRASE` if encrypted), **password**, then the **SSH agent** when neither is set (`SSH_AUTH_SOCK`, or the OpenSSH named pipe on Windows). A key path that doesn't exist is reported at startup, not at first connection.

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
            "command": "npx", "args": ["-y", "@akms/mcp-ssh"],
            "env": { "SSH_HOST": "10.0.0.5", "SSH_USER": "deploy", "SSH_READONLY": "true" }
        },
        "ssh-dev": {
            "command": "npx", "args": ["-y", "@akms/mcp-ssh"],
            "env": { "SSH_HOST": "192.168.0.10", "SSH_USER": "ubuntu" }
        }
    }
}
```

### Check it before wiring it up

```bash
akms-mcp-ssh --check          # or: npx -y @akms/mcp-ssh --check
```

Connects to the configured host and reports what happened — exit code 0 when it is reachable. Otherwise a setup mistake is indistinguishable from a policy rejection when the agent tries something. Add `SSH_MCP_LOG_LEVEL=debug` to see the handshake.

```
Checking prod-web  →  deploy@10.0.0.5:22

  OK      deploy@10.0.0.5:22  (key /home/me/.ssh/id_ed25519, 412ms)
          host key SHA256:9x2K…  (not pinned — set SSH_HOST_KEY to it to detect a changed key)
```

That fingerprint is the same string `ssh-keyscan -t ed25519 host | ssh-keygen -lf -` gives — copy it into `SSH_HOST_KEY` to pin it. **An unpinned host accepts whatever key the server presents**: fine on a LAN, worth pinning across the internet, and the thing that tells you a host was rebuilt.

## 🧰 Tools

| Tool | Purpose |
|---|---|
| `ssh_list_hosts` | The configured host and its guard policy. No credentials |
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

## 📄 Logging

Everything goes to **stderr** (stdout is the MCP protocol channel). `SSH_MCP_LOG_LEVEL` picks the level — `silent` / `debug` / `info` / `warn` / `error`, default `info`. Guard rejections are logged at `warn` with the full command, and that log is the audit trail for what the agent tried; full command text is otherwise only logged at `debug`, while `password`, `passphrase`, `privateKey` and `token` meta keys are always masked.

## ⚠️ Security notes

**The real boundary is the remote account.** The guards stop mistakes; containment has to come from the host — give each server entry a dedicated unprivileged user rather than `root`, restrict its `sudoers` entries to the exact commands it needs, pair `SSH_READONLY=true` with filesystem permissions that agree with it, reach for `SSH_ALLOW_COMMANDS` on the strictest hosts, and back up anything you would miss.

- The MCP client entry names the host and may hold `SSH_PASSWORD` or `SSH_PASSPHRASE`. Prefer a key file so only its *path* is stored, keep the entry out of version control, and `chmod 600` it — the shipped `.gitignore` already excludes `*.pem`, `id_rsa*` and `id_ed25519*`.
- **Anything the agent can reach, a prompt injection can reach.** Output from a remote host is untrusted input; a file the agent reads can contain instructions. With permissive defaults that matters more, not less — keep a production entry `SSH_READONLY=true` and let write access be a deliberate exception.
- The catastrophe rules are the *only* ones that hold regardless of configuration, and even they read the command as text. Treat them as a seatbelt, not a cage.
- Point this at hosts you are authorized to administer. This is an administration tool, not a scanner.
- Local paths are resolved against the machine running the server, so on Windows a POSIX-looking `/tmp/x` becomes `<current drive>\tmp\x`. Every transfer reply prints the resolved path — check it.

## 🧑‍💻 Development

Building on this server, embedding it as a library, or changing the guards — see [README_DEV.md](README_DEV.md).

## 📜 License

MIT — see [LICENSE.md](LICENSE.md).
