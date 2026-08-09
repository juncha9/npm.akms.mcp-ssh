import { createHash } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import ssh2 from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";

import { CWD_MARKER, KEEPALIVE_INTERVAL_MS } from "@/_defs";
import { $logger, quoteShellArgument, truncateOutput } from "@/_libs";
import type { SshExecResult, SshHostProfile } from "@/_types";
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
 * @throws {Error} If the file cannot be read. The path is deliberately kept out of the
 *                 message — it reaches the model verbatim, and the rest of the codebase
 *                 (logger masking, `toHostSummary`) treats it as a secret.
 */
function readPrivateKey(profile: SshHostProfile, keyPath: string): Buffer {
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
        const _logger = $logger.child({ context: "readPrivateKey", profile: profile.name });
        _logger.error(ex, "cannot read the profile's private key file");
        throw new Error(`cannot read the private key configured for profile '${profile.name}' (see the server log for the path)`);
    }
}

/** OpenSSH-style fingerprint — the same string `ssh-keyscan` and `ssh` itself print. */
export function toHostKeyFingerprint(hostKey: Buffer): string {
    const digest = createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}`;
}

/**
 * Builds the host key check.
 *
 * ssh2 accepts *any* host key when no verifier is supplied, so without this a
 * man-in-the-middle — or a rebuilt server presenting a new key — is indistinguishable
 * from the real host. Pinning stays opt-in (`hostKeyFingerprint`) to match the permissive
 * defaults, but the fingerprint is always logged on first connect so it can be copied
 * into the profile.
 */
function buildHostVerifier(
    profile: SshHostProfile,
    onHostKeySeen: (fingerprint: string) => void
): (hostKey: Buffer) => boolean {
    return (hostKey: Buffer) => {
        const fingerprint = toHostKeyFingerprint(hostKey);
        onHostKeySeen(fingerprint);

        const _logger = $logger.child({ context: "hostVerifier", profile: profile.name, host: profile.host });

        if (profile.hostKeyFingerprint == null) {
            _logger.info("host key accepted unpinned; add hostKeyFingerprint to the profile to pin it", {
                host_key_fingerprint: fingerprint,
            });
            return true;
        }

        if (profile.hostKeyFingerprint === fingerprint) {
            _logger.debug("host key matches the pinned fingerprint");
            return true;
        }

        _logger.error(null, "host key does not match the pinned fingerprint", {
            expected: profile.hostKeyFingerprint,
            actual: fingerprint,
        });
        return false;
    };
}

/** Profile → ssh2 connect options. */
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
        hostVerifier: buildHostVerifier(profile, onHostKeySeen),
    };

    if (profile.privateKeyPath != null) {
        connectConfig.privateKey = readPrivateKey(profile, profile.privateKeyPath);
    }

    if (profile.passphrase != null) {
        connectConfig.passphrase = profile.passphrase;
    }

    if (profile.password != null) {
        connectConfig.password = profile.password;
    }

    // No key and no password — fall back to the running SSH agent, which is how most
    // interactive setups already authenticate.
    if (connectConfig.privateKey == null && connectConfig.password == null) {
        connectConfig.agent = resolveAgentPath();
    }

    return connectConfig;
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

    constructor(public readonly profile: SshHostProfile) {
    }

    get isConnected(): boolean {
        return this.client != null;
    }

    /** Host key the server presented, once a handshake has been attempted. */
    get hostKeyFingerprint(): string | null {
        return this.observedFingerprint;
    }

    /** True when a connection was established and then lost, so shell state is gone. */
    get wasDropped(): boolean {
        return this.droppedAfterReady;
    }

    /**
     * Opens the connection, or joins the in-flight attempt when one is already running.
     *
     * @throws {Error} If the connection was closed, authentication fails, the host is
     *                 unreachable, or the handshake times out.
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

        this.connecting = new Promise<void>((resolve, reject) => {
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

                _logger.error(error, "ssh connection error after ready");
            });

            client.on("close", () => {
                if (this.client === client) {
                    _logger.debug("ssh connection closed by the peer");
                    this.client = null;
                    this.droppedAfterReady = true;
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
