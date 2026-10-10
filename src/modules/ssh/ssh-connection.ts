import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import ssh2 from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

import { CWD_MARKER, KEEPALIVE_INTERVAL_MS } from "@/_defs";
import { $logger, quoteShellArgument, truncateOutput } from "@/_libs";
import type { SshExecResult, SshHostProfile, SshJumpProfile } from "@/_types";
import { GuardRejectionError, canonicalizeCommand, inspectCommand, inspectWorkingDirectory } from "@/modules/guard";

const { Client } = ssh2;

/** Stops runaway output from filling the heap before truncation can happen. */
const OUTPUT_HARD_CAP_MULTIPLIER = 4;

/** Key file contents by absolute path — immutable for the process lifetime. */
const PRIVATE_KEY_CACHE = new Map<string, Buffer>();

export interface SshExecOptions {
    command: string;
    /** Directory to `cd` into first; the login shell's default is used when absent. */
    cwd?: string;
    timeoutMs: number;
    maxOutputCharacters: number;
    /** Appends a `$PWD` marker so a session can follow `cd` between commands. */
    trackCwd: boolean;
}

/** Windows OpenSSH agent pipe — ssh2 accepts it wherever a socket path is expected. */
const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

function resolveAgentPath(): string | undefined {
    const authSocket = process.env.SSH_AUTH_SOCK;
    if (authSocket != null && authSocket !== "") {
        return authSocket;
    }

    if (process.platform === "win32") {
        return WINDOWS_AGENT_PIPE;
    }

    return undefined;
}

/**
 * Reads a private key, caching by path.
 *
 * Without the cache every one-off tool call re-read the same file synchronously, stalling
 * the event loop for every other in-flight call.
 *
 * @param label Names the hop in the error, e.g. the profile name or "<name> jump host".
 * @throws {Error} If the file cannot be read. The path is deliberately kept out of the
 *                 message — it reaches the model verbatim, and the rest of the codebase
 *                 (logger masking, `toHostSummary`) treats it as a secret.
 */
function readPrivateKey(label: string, keyPath: string): Buffer {
    const cached = PRIVATE_KEY_CACHE.get(keyPath);
    if (cached != null) {
        return cached;
    }

    try {
        const contents = fs.readFileSync(keyPath);
        PRIVATE_KEY_CACHE.set(keyPath, contents);
        return contents;
    }
    catch (ex) {
        const _logger = $logger.child({ context: "readPrivateKey", profile: label });
        _logger.error(ex, "cannot read the private key file");
        throw new Error(`cannot read the private key configured for '${label}' (see the server log for the path)`);
    }
}

/** Credentials a hop authenticates with — the same three fields on the target and the jump host. */
interface HopCredentials {
    privateKeyPath?: string;
    passphrase?: string;
    password?: string;
}

/** Applies the auth order — private key, password, then the SSH agent — onto a connect config. */
function applyAuth(connectConfig: ConnectConfig, credentials: HopCredentials, label: string): void {
    if (credentials.privateKeyPath != null) {
        connectConfig.privateKey = readPrivateKey(label, credentials.privateKeyPath);
    }

    if (credentials.passphrase != null) {
        connectConfig.passphrase = credentials.passphrase;
    }

    if (credentials.password != null) {
        connectConfig.password = credentials.password;
    }

    // No key and no password — fall back to the running SSH agent, which is how most
    // interactive setups already authenticate.
    if (connectConfig.privateKey == null && connectConfig.password == null) {
        connectConfig.agent = resolveAgentPath();
    }
}

/** OpenSSH-style fingerprint — the same string `ssh-keyscan` and `ssh` itself print. */
export function toHostKeyFingerprint(hostKey: Buffer): string {
    const digest = createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}`;
}

/**
 * Builds the host key check for one hop.
 *
 * ssh2 accepts *any* host key when no verifier is supplied, so without this a
 * man-in-the-middle — or a rebuilt server presenting a new key — is indistinguishable
 * from the real host. Pinning stays opt-in (`pinnedFingerprint`) to match the permissive
 * defaults, but the fingerprint is always logged on first connect so it can be copied
 * into the profile.
 */
function buildHostVerifier(
    hop: { label: string; host: string; pinnedFingerprint?: string },
    onHostKeySeen: (fingerprint: string) => void
): (hostKey: Buffer) => boolean {
    return (hostKey: Buffer) => {
        const fingerprint = toHostKeyFingerprint(hostKey);
        onHostKeySeen(fingerprint);

        const _logger = $logger.child({ context: "hostVerifier", profile: hop.label, host: hop.host });

        if (hop.pinnedFingerprint == null) {
            _logger.info("host key accepted unpinned; pin the fingerprint in the profile to detect a changed key", {
                host_key_fingerprint: fingerprint,
            });
            return true;
        }

        if (hop.pinnedFingerprint === fingerprint) {
            _logger.debug("host key matches the pinned fingerprint");
            return true;
        }

        _logger.error(null, "host key does not match the pinned fingerprint", {
            expected: hop.pinnedFingerprint,
            actual: fingerprint,
        });
        return false;
    };
}

/** Profile → ssh2 connect options for the target hop. */
function buildConnectConfig(
    profile: SshHostProfile,
    onHostKeySeen: (fingerprint: string) => void
): ConnectConfig {
    const connectConfig: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        readyTimeout: profile.policy.connectTimeoutMs,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        hostVerifier: buildHostVerifier(
            { label: profile.name, host: profile.host, pinnedFingerprint: profile.hostKeyFingerprint },
            onHostKeySeen
        ),
    };

    applyAuth(connectConfig, profile, profile.name);

    return connectConfig;
}

/**
 * The stream the target handshake runs over when it is not a plain TCP socket, plus the
 * resource behind it — a jump client or a proxy process — that must go when the target
 * connection does.
 */
interface Transport {
    sock: Duplex;
    close(): void;
}

/** OpenSSH `ProxyCommand` tokens: `%h` host, `%p` port, `%r` user, `%%` a literal `%`. */
export function expandProxyCommand(template: string, hop: { host: string; port: number; username: string }): string {
    return template.replace(/%[hpr%]/g, (token) => {
        if (token === "%h") {
            return hop.host;
        }

        if (token === "%p") {
            return String(hop.port);
        }

        if (token === "%r") {
            return hop.username;
        }

        return "%";
    });
}

/**
 * Starts the proxy command and exposes its stdin/stdout as the SSH stream.
 *
 * Runs through the shell, as OpenSSH does, so the operator can quote arguments the way
 * they would in `~/.ssh/config`. The process is killed when the transport closes: on
 * Windows the shell is `cmd.exe` and the real command is its child, so the whole tree
 * has to go or `cloudflared` would outlive the connection it was carrying.
 */
function openProxyCommand(profile: SshHostProfile, hop: { host: string; port: number; username: string }): Transport {
    const command = expandProxyCommand(profile.proxyCommand ?? "", hop);
    const _logger = $logger.child({ context: "openProxyCommand", profile: profile.name });
    _logger.debug("starting the proxy command", { command: command });

    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    // The command's own diagnostics — a cloudflared login prompt, a refused tunnel — are
    // the only clue when the handshake never starts, so they go to the log at warn.
    const stderrDecoder = new StringDecoder("utf8");
    child.stderr.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk).trim();
        if (text !== "") {
            _logger.warn("proxy command stderr", { text: text });
        }
    });

    child.on("exit", (code, signal) => {
        _logger.debug("proxy command exited", { exit_code: code, signal: signal });
    });

    const sock = Duplex.from({ readable: child.stdout, writable: child.stdin });

    // Permanent listener: killing the process tears its pipes down, and the stream reports
    // that as an error. ssh2 only listens once it has been handed the stream, so a kill
    // before the handshake (an unreadable jump key, a disconnect mid-setup) would
    // otherwise surface as an unhandled 'error' and take the whole server down.
    sock.on("error", (error: Error) => {
        _logger.debug("proxy command stream error", { error_message: error.message });
    });

    // A spawn failure surfaces on the child, not on the stream; forward it so ssh2
    // reports it as a socket error instead of waiting for the ready timeout.
    child.on("error", (error: Error) => {
        sock.destroy(error);
    });

    // Latch: close() is reached from both the jump client's and the target client's
    // 'close' handlers when the two are stacked, and one kill is enough.
    let closed = false;

    return {
        sock: sock,
        close: () => {
            if (closed == true) {
                return;
            }
            closed = true;

            if (child.exitCode != null || child.signalCode != null) {
                return;
            }

            if (process.platform === "win32" && child.pid != null) {
                const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
                // Without a listener a failure to even start taskkill is an unhandled
                // 'error' event, which takes the whole server down with it.
                killer.on("error", (error: Error) => {
                    _logger.error(error, "failed to kill the proxy command's process tree");
                });
                return;
            }

            child.kill();
        },
    };
}

/**
 * Connects to the jump host and opens a forwarded TCP channel to the target, which the
 * target handshake then runs over — what `ssh -J` does.
 *
 * @param proxy Carries the jump hop itself when a proxy command is also configured.
 * @throws {Error} If the jump host cannot be reached or refuses the forward. The message
 *                 names the jump host, so a failure there is not mistaken for the target.
 */
function openJumpTransport(
    profile: SshHostProfile,
    jump: SshJumpProfile,
    proxy: Transport | null,
    onHostKeySeen: (fingerprint: string) => void
): Promise<Transport> {
    const label = `${profile.name} jump host`;
    const endpoint = `${jump.username}@${jump.host}:${jump.port}`;
    const _logger = $logger.child({ context: "openJumpTransport", profile: profile.name, jump_host: jump.host });

    const jumpConfig: ConnectConfig = {
        host: jump.host,
        port: jump.port,
        username: jump.username,
        readyTimeout: profile.policy.connectTimeoutMs,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        hostVerifier: buildHostVerifier(
            { label: label, host: jump.host, pinnedFingerprint: jump.hostKeyFingerprint },
            onHostKeySeen
        ),
    };

    applyAuth(jumpConfig, jump, label);

    if (proxy != null) {
        jumpConfig.sock = proxy.sock;
    }

    return new Promise<Transport>((resolve, reject) => {
        const jumpClient = new Client();
        let settled = false;

        jumpClient.on("error", (error: Error) => {
            if (settled == false) {
                settled = true;
                jumpClient.destroy();
                reject(new Error(`jump host ${endpoint}: ${error.message}`));
                return;
            }

            _logger.error(error, "jump host connection error after ready");
        });

        jumpClient.on("close", () => {
            _logger.debug("jump host connection closed");
            proxy?.close();

            if (settled == false) {
                settled = true;
                reject(new Error(`jump host ${endpoint}: connection closed before the handshake completed`));
            }
        });

        jumpClient.once("ready", () => {
            if (settled == true) {
                return;
            }

            jumpClient.forwardOut("127.0.0.1", 0, profile.host, profile.port, (error, stream) => {
                if (settled == true) {
                    return;
                }
                settled = true;

                if (error != null) {
                    jumpClient.end();
                    reject(new Error(`jump host ${endpoint} refused the forward to ${profile.host}:${profile.port}: ${error.message}`));
                    return;
                }

                _logger.info("jump host connected, target channel forwarded");
                resolve({
                    sock: stream,
                    close: () => {
                        jumpClient.end();
                    },
                });
            });
        });

        jumpClient.connect(jumpConfig);
    });
}

/**
 * Opens whatever carries the target handshake: nothing for a direct TCP connection, a
 * proxy process, a jump channel, or a jump channel whose own hop runs over the proxy.
 */
async function openTransport(
    profile: SshHostProfile,
    onJumpHostKeySeen: (fingerprint: string) => void
): Promise<Transport | null> {
    let proxy: Transport | null = null;
    if (profile.proxyCommand != null) {
        proxy = openProxyCommand(profile, profile.jump ?? profile);
    }

    if (profile.jump == null) {
        return proxy;
    }

    // The proxy process is already running by now; a jump hop that cannot even be set
    // up (an unreadable jump key throws before any socket is touched) must not leave it
    // behind as an orphan.
    try {
        const jumpTransport = await openJumpTransport(profile, profile.jump, proxy, onJumpHostKeySeen);
        return jumpTransport;
    }
    catch (ex) {
        proxy?.close();
        throw ex;
    }
}

/**
 * Wraps the user command so the remote shell reports where it ended up.
 *
 * `$?` is captured before the marker is printed and replayed via `exit`, so the exit
 * status the caller sees is the command's, not `printf`'s.
 *
 * `cwd` appears exactly once, inside `quoteShellArgument`. It must never be interpolated
 * anywhere else — an earlier version echoed it into a double-quoted diagnostic, which let
 * `cwd: '/x"; rm -rf /; #'` run arbitrary commands with every guard bypassed. The failure
 * message is therefore a fixed string.
 */
export function buildRemoteCommand(command: string, cwd: string | undefined, trackCwd: boolean): string {
    const lines: string[] = [];

    if (cwd != null && cwd !== "") {
        const quotedCwd = quoteShellArgument(cwd);
        lines.push(`cd ${quotedCwd} 2>/dev/null || { echo 'akms-mcp-ssh: cannot enter the requested working directory' >&2; exit 1; }`);
    }

    lines.push(command);

    if (trackCwd == true) {
        lines.push("__akms_exit=$?");
        lines.push(`printf '\\n${CWD_MARKER}%s' "$PWD"`);
        lines.push("exit $__akms_exit");
    }

    return lines.join("\n");
}

/** Splits the trailing `$PWD` marker off stdout. */
export function extractCwdMarker(stdout: string): { output: string; cwd?: string } {
    const markerIndex = stdout.lastIndexOf(CWD_MARKER);
    if (markerIndex < 0) {
        return { output: stdout };
    }

    // First line only: `$PWD` is a single line, so anything past a newline is not the
    // directory and must not end up in the `cd` prefix of the next command.
    const markerPayload = stdout.slice(markerIndex + CWD_MARKER.length);
    const cwd = (markerPayload.split("\n")[0] ?? "").trim();

    let output = stdout.slice(0, markerIndex);
    if (output.endsWith("\n") == true) {
        output = output.slice(0, -1);
    }

    if (cwd === "") {
        return { output: output };
    }

    return { output: output, cwd: cwd };
}

/**
 * One ssh2 client bound to a profile, plus the exec / SFTP operations run over it.
 *
 * This class is the chokepoint: it holds the profile, so it applies the command guard
 * itself rather than trusting each caller to remember. Enforcement in the tool handlers
 * was one forgotten line away from shipping an unscreened command — and one such caller
 * (the `ssh_connect` probe) already existed.
 */
export class SshConnection {
    private client: ssh2.Client | null = null;
    private pendingClient: ssh2.Client | null = null;
    private connecting: Promise<void> | null = null;
    private disposed = false;
    /** Set when the peer closed a previously established connection. */
    private droppedAfterReady = false;
    private observedFingerprint: string | null = null;
    private observedJumpFingerprint: string | null = null;

    constructor(public readonly profile: SshHostProfile) {
    }

    get isConnected(): boolean {
        return this.client != null;
    }

    /** Host key the server presented, once a handshake has been attempted. */
    get hostKeyFingerprint(): string | null {
        return this.observedFingerprint;
    }

    /** Host key the jump host presented; null without a jump host or before its handshake. */
    get jumpHostKeyFingerprint(): string | null {
        return this.observedJumpFingerprint;
    }

    /** True when a connection was established and then lost, so shell state is gone. */
    get wasDropped(): boolean {
        return this.droppedAfterReady;
    }

    /**
     * Opens the connection, or joins the in-flight attempt when one is already running.
     *
     * With a proxy command or a jump host the carrier is opened first and handed to ssh2
     * as the socket; it is torn down with the target connection, whichever side closes.
     *
     * @throws {Error} If the connection was closed, authentication fails, the host is
     *                 unreachable, the handshake times out, or the carrier cannot be opened.
     */
    async connect(): Promise<void> {
        if (this.disposed == true) {
            throw new Error(`ssh connection for '${this.profile.name}' has been closed; open a new session`);
        }

        if (this.client != null) {
            return;
        }

        if (this.connecting != null) {
            await this.connecting;
            return;
        }

        const _logger = $logger.child({
            context: "SshConnection.connect",
            profile: this.profile.name,
            host: this.profile.host,
            port: this.profile.port,
            username: this.profile.username,
        });

        const connectConfig = buildConnectConfig(this.profile, (fingerprint) => {
            this.observedFingerprint = fingerprint;
        });

        this.connecting = (async () => {
            const transport = await openTransport(this.profile, (fingerprint) => {
                this.observedJumpFingerprint = fingerprint;
            });

            // disconnect() may have run while the carrier was being opened.
            if (this.disposed == true) {
                transport?.close();
                throw new Error(`ssh connection for '${this.profile.name}' was closed during the handshake`);
            }

            if (transport != null) {
                connectConfig.sock = transport.sock;
            }

            await new Promise<void>((resolve, reject) => {
                const client = new Client();
                this.pendingClient = client;
                let settled = false;

                // One permanent 'error' listener, installed before connect() and never
                // removed. Registering it with `once` left the client listener-less after the
                // first error, and ssh2 emits 'error' again while the socket tears down —
                // an unhandled 'error' event takes down the whole server process.
                client.on("error", (error: Error) => {
                    if (settled == false) {
                        settled = true;
                        this.pendingClient = null;
                        client.destroy();
                        reject(error);
                        return;
                    }

                    // Only a live connection's error is news. A failed handshake is
                    // already reported through reject(); ssh2 keeps emitting while the
                    // socket tears down ("Connection lost before handshake", an abort
                    // from the destroyed proxy stream) and those are just the aftermath.
                    if (this.client !== client) {
                        _logger.debug("ssh connection error during teardown", { error_message: error.message });
                        return;
                    }

                    _logger.error(error, "ssh connection error after ready");
                });

                client.on("close", () => {
                    // Whichever side closed, the carrier behind this connection is done with.
                    transport?.close();

                    if (this.client === client) {
                        _logger.debug("ssh connection closed by the peer");
                        this.client = null;
                        this.droppedAfterReady = true;
                        return;
                    }

                    // A carrier that ends before the handshake (a proxy command that exited at
                    // once) closes without a usable 'error'; settle here or connect() hangs.
                    if (settled == false) {
                        settled = true;
                        this.pendingClient = null;
                        reject(new Error("connection closed before the handshake completed"));
                    }
                });

                client.once("ready", () => {
                    if (settled == true) {
                        return;
                    }
                    settled = true;
                    this.pendingClient = null;

                    // disconnect() may have run while the handshake was in flight; adopting
                    // the client now would leak a live connection nothing can ever close.
                    if (this.disposed == true) {
                        client.destroy();
                        reject(new Error(`ssh connection for '${this.profile.name}' was closed during the handshake`));
                        return;
                    }

                    this.client = client;
                    resolve();
                });

                client.connect(connectConfig);
            });
        })();

        try {
            await this.connecting;
            _logger.info("ssh connection established");
        }
        catch (ex) {
            _logger.error(ex, "ssh connection failed");

            let detail = String(ex);
            if (ex instanceof Error) {
                detail = ex.message;
            }

            throw new Error(`ssh connect failed for '${this.profile.name}' (${this.profile.username}@${this.profile.host}:${this.profile.port}): ${detail}`);
        }
        finally {
            this.connecting = null;
        }
    }

    /**
     * Screens a command against this profile's policy, then runs it on its own channel.
     *
     * The canonical form is what gets screened *and* what gets sent — validating one
     * string while executing another is a bypass by construction.
     *
     * @throws {GuardRejectionError} If the policy refuses the command or the cwd.
     * @throws {Error} If the connection is closed or the channel cannot be opened.
     */
    async exec(options: SshExecOptions): Promise<SshExecResult> {
        const canonicalCommand = canonicalizeCommand(options.command);

        const verdict = inspectCommand(canonicalCommand, this.profile.policy);
        if (verdict.allowed == false) {
            throw new GuardRejectionError(verdict);
        }

        if (options.cwd != null) {
            const cwdVerdict = inspectWorkingDirectory(options.cwd);
            if (cwdVerdict.allowed == false) {
                throw new GuardRejectionError(cwdVerdict);
            }
        }

        await this.connect();

        const client = this.client;
        if (client == null) {
            throw new Error(`ssh connection for '${this.profile.name}' is not open`);
        }

        const _logger = $logger.child({
            context: "SshConnection.exec",
            profile: this.profile.name,
            cwd: options.cwd,
        });

        const remoteCommand = buildRemoteCommand(canonicalCommand, options.cwd, options.trackCwd);
        const hardCap = options.maxOutputCharacters * OUTPUT_HARD_CAP_MULTIPLIER;
        const startedAt = Date.now();

        const raw = await new Promise<{
            stdout: string;
            stderr: string;
            exitCode: number | null;
            signal?: string;
            timedOut: boolean;
        }>((resolve, reject) => {
            client.exec(remoteCommand, (error, channel) => {
                if (error != null) {
                    reject(error);
                    return;
                }

                let stdout = "";
                let stderr = "";
                let exitCode: number | null = null;
                let signal: string | undefined = undefined;
                let timedOut = false;
                let settled = false;
                // Latch: channel.close() is a round trip, so packets keep arriving after
                // the cap trips. Without it each one re-logged and re-grew the string.
                let capExceeded = false;

                // One decoder per stream: a multi-byte character split across two SSH
                // packets decodes to U+FFFD if each chunk is converted on its own.
                const stdoutDecoder = new StringDecoder("utf8");
                const stderrDecoder = new StringDecoder("utf8");

                const timeoutTimer = setTimeout(() => {
                    timedOut = true;
                    _logger.warn("command timed out, closing the channel", { timeout_ms: options.timeoutMs });
                    channel.close();
                }, options.timeoutMs);
                timeoutTimer.unref();

                // Only 'close' settles the promise. 'end' fires on CHANNEL_EOF, which the
                // remote may send before the separate exit-status request arrives — settling
                // there reports a successful command as `exit code: none (killed)`.
                const finish = (): void => {
                    if (settled == true) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timeoutTimer);

                    stdout += stdoutDecoder.end();
                    stderr += stderrDecoder.end();

                    resolve({ stdout: stdout, stderr: stderr, exitCode: exitCode, signal: signal, timedOut: timedOut });
                };

                channel.on("data", (chunk: Buffer) => {
                    if (capExceeded == true) {
                        return;
                    }

                    stdout += stdoutDecoder.write(chunk);
                    if (stdout.length > hardCap) {
                        capExceeded = true;
                        _logger.warn("stdout exceeded the hard cap, closing the channel", { hard_cap: hardCap });
                        channel.close();
                    }
                });

                channel.stderr.on("data", (chunk: Buffer) => {
                    if (capExceeded == true) {
                        return;
                    }

                    stderr += stderrDecoder.write(chunk);
                    if (stderr.length > hardCap) {
                        capExceeded = true;
                        channel.close();
                    }
                });

                channel.on("exit", (code: number | null, exitSignal?: string) => {
                    exitCode = code;
                    signal = exitSignal;
                });

                channel.on("close", finish);
                channel.on("error", (channelError: Error) => {
                    clearTimeout(timeoutTimer);
                    if (settled == true) {
                        return;
                    }
                    settled = true;
                    reject(channelError);
                });

                // Send EOF on the remote stdin straight away. Nothing will ever be written
                // to it, and a command that reads — a `sudo` password prompt, an apt
                // confirmation, `ssh-keygen` — would otherwise sit there until the timeout
                // fires. With stdin closed it fails in milliseconds with a usable message.
                //
                // `eof()`, not `end()`: end() also closes the channel, which loses the
                // exit-status request the server sends afterwards.
                channel.eof();
            });
        });

        // Only parse the marker when this call asked for it — otherwise output that merely
        // contains the marker text would be silently cut at that point.
        let output = raw.stdout;
        let cwd: string | undefined = undefined;
        if (options.trackCwd == true) {
            const parsed = extractCwdMarker(raw.stdout);
            output = parsed.output;
            cwd = parsed.cwd;
        }

        const truncatedStdout = truncateOutput(output, options.maxOutputCharacters);
        const truncatedStderr = truncateOutput(raw.stderr, options.maxOutputCharacters);

        const result: SshExecResult = {
            stdout: truncatedStdout.text,
            stderr: truncatedStderr.text,
            exitCode: raw.exitCode,
            timedOut: raw.timedOut,
            truncated: truncatedStdout.truncated == true || truncatedStderr.truncated == true,
            durationMs: Date.now() - startedAt,
        };

        if (raw.signal != null) {
            result.signal = raw.signal;
        }

        if (cwd != null) {
            result.cwd = cwd;
        }

        _logger.debug("command finished", {
            exit_code: result.exitCode,
            duration_ms: result.durationMs,
            timed_out: result.timedOut,
        });

        return result;
    }

    /**
     * Opens an SFTP channel, hands it to `handler`, and closes it afterwards.
     *
     * A channel per operation costs one round trip but keeps a broken transfer from
     * poisoning later ones — SFTP channels do not recover from a mid-stream error.
     *
     * The channel's own `error` event is wired into the returned promise: ssh2 strips its
     * setup listeners before handing the wrapper over, so an unhandled SFTP protocol error
     * would otherwise crash the process rather than fail this one call.
     *
     * @throws {Error} If the SFTP subsystem cannot be started or the channel errors.
     */
    async withSftp<T>(handler: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
        await this.connect();

        const client = this.client;
        if (client == null) {
            throw new Error(`ssh connection for '${this.profile.name}' is not open`);
        }

        const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((error, sftpWrapper) => {
                if (error != null) {
                    reject(error);
                    return;
                }

                resolve(sftpWrapper);
            });
        });

        return await new Promise<T>((resolve, reject) => {
            let settled = false;

            const finish = (settle: () => void): void => {
                if (settled == true) {
                    return;
                }
                settled = true;

                try {
                    sftp.end();
                }
                catch (ex) {
                    const _logger = $logger.child({ context: "SshConnection.withSftp", profile: this.profile.name });
                    _logger.error(ex, "failed to close the sftp channel");
                }

                settle();
            };

            sftp.on("error", (error: Error) => {
                finish(() => {
                    reject(error);
                });
            });

            handler(sftp).then(
                (value) => {
                    finish(() => {
                        resolve(value);
                    });
                },
                (error: unknown) => {
                    finish(() => {
                        reject(error);
                    });
                }
            );
        });
    }

    /** Closes the connection for good; a disposed connection will not re-dial. */
    disconnect(): void {
        this.disposed = true;

        // A handshake still in flight would otherwise complete and install its client on
        // an object nothing holds a reference to any more.
        if (this.pendingClient != null) {
            this.pendingClient.destroy();
            this.pendingClient = null;
        }

        if (this.client == null) {
            return;
        }

        this.client.end();
        this.client = null;
    }
}
