import { setInterval, clearInterval } from "node:timers";

import { SESSION_IDLE_TIMEOUT_MS, SESSION_SWEEP_INTERVAL_MS } from "@/_defs";
import { $logger } from "@/_libs";
import type { SshExecResult, SshHostProfile, SshSessionInfo } from "@/_types";
import { inspectWorkingDirectory } from "@/modules/guard";

import { SshConnection } from "./ssh-connection";

/** Ceiling on concurrently open sessions, so a runaway loop can't exhaust file descriptors. */
const MAX_OPEN_SESSIONS = 32;

/** A connection plus the shell state (working directory) carried across commands. */
export class SshSession {
    /** Empty until the first command reports `$PWD`; then the real remote path. */
    cwd: string;
    lastUsedAt: Date;
    execCount = 0;

    readonly openedAt = new Date();

    /** Tail of the serialized operation chain; see `runExclusive`. */
    private operationChain: Promise<unknown> = Promise.resolve();
    private activeOperationCount = 0;

    constructor(
        public readonly sessionId: string,
        public readonly connection: SshConnection
    ) {
        this.cwd = connection.profile.defaultCwd ?? "";
        this.lastUsedAt = new Date();
    }

    get profile(): SshHostProfile {
        return this.connection.profile;
    }

    /** True while an operation is running, so the idle sweeper leaves it alone. */
    get isBusy(): boolean {
        return this.activeOperationCount > 0;
    }

    /** Marks the session as in use. */
    touch(): void {
        this.lastUsedAt = new Date();
    }

    /**
     * Runs `operation` with exclusive use of this session.
     *
     * Serialized because `cwd` is read-modify-write across a network round trip: two
     * concurrent calls both read the old directory, and the one that finishes second
     * writes it back — silently undoing the other's `cd`. Bracketing with `touch()` also
     * keeps the idle sweeper off a session that is mid-transfer.
     */
    async runExclusive<T>(operation: (connection: SshConnection) => Promise<T>): Promise<T> {
        const previous = this.operationChain;

        let releaseChain: () => void = () => {
            // Replaced below; assigned here so the type is not nullable.
        };
        this.operationChain = new Promise<void>((resolve) => {
            releaseChain = resolve;
        });

        await previous.catch(() => {
            // A failed predecessor must not poison the queue for later callers.
        });

        this.activeOperationCount += 1;
        this.touch();

        try {
            return await operation(this.connection);
        }
        finally {
            this.activeOperationCount -= 1;
            this.touch();
            releaseChain();
        }
    }

    /**
     * Runs a command in this session's working directory and adopts wherever it ended up,
     * so a `cd` in one call is still in effect on the next.
     *
     * Passing `cwd` runs this command elsewhere *and* moves the session there — same
     * result as prefixing `cd <cwd> &&`, which is what a shell user would expect.
     *
     * @throws {Error} If the connection was dropped since the session opened. A silent
     *                 re-dial would hand back a fresh login shell while the model still
     *                 believes it holds the old one — environment, sudo cache and
     *                 background jobs all gone with no signal.
     */
    async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<SshExecResult> {
        if (this.connection.wasDropped == true) {
            throw new Error(`session ${this.sessionId} lost its connection to ${this.profile.host}; its shell state is gone — open a new session with ssh_connect`);
        }

        const policy = this.profile.policy;
        const targetCwd = options?.cwd ?? this.cwd;

        return await this.runExclusive(async (connection) => {
            const result = await connection.exec({
                command: command,
                cwd: targetCwd,
                timeoutMs: options?.timeoutMs ?? policy.execTimeoutMs,
                maxOutputCharacters: policy.maxOutputCharacters,
                trackCwd: true,
            });

            if (result.cwd != null && result.cwd !== "") {
                // The reported `$PWD` becomes the `cd` argument of the next command, so it
                // goes through the same metacharacter check as a caller-supplied cwd.
                const verdict = inspectWorkingDirectory(result.cwd);
                if (verdict.allowed == true) {
                    this.cwd = result.cwd;
                }
                else {
                    const _logger = $logger.child({ context: "SshSession.exec", session_id: this.sessionId });
                    _logger.warn("remote working directory contains unsafe characters, keeping the previous cwd", {
                        reported_cwd: result.cwd,
                    });
                }
            }

            this.execCount += 1;
            return result;
        });
    }

    toInfo(): SshSessionInfo {
        let displayCwd = this.cwd;
        if (displayCwd === "") {
            displayCwd = "(login default)";
        }

        return {
            sessionId: this.sessionId,
            profileName: this.profile.name,
            host: this.profile.host,
            username: this.profile.username,
            cwd: displayCwd,
            openedAt: this.openedAt.toISOString(),
            lastUsedAt: this.lastUsedAt.toISOString(),
            execCount: this.execCount,
        };
    }
}

/** Owns every open session: creation, lookup, idle expiry and shutdown. */
export class SshSessionManager {
    private readonly sessions = new Map<string, SshSession>();
    private sequence = 0;
    private pendingOpenCount = 0;
    private sweepTimer: NodeJS.Timeout | null = null;

    /**
     * Opens a connection and registers it as a session.
     *
     * `pendingOpenCount` reserves the slot across the `await`: checking `sessions.size`
     * alone let N concurrent calls all observe the same pre-connect count and blow past
     * the ceiling together.
     *
     * @throws {Error} If the session ceiling is reached or the connection fails.
     */
    async open(profile: SshHostProfile): Promise<SshSession> {
        if (this.sessions.size + this.pendingOpenCount >= MAX_OPEN_SESSIONS) {
            throw new Error(`too many open ssh sessions (${MAX_OPEN_SESSIONS}), close some with ssh_disconnect first`);
        }

        this.sequence += 1;
        const sessionId = `${profile.name}#${this.sequence}`;

        const connection = new SshConnection(profile);

        this.pendingOpenCount += 1;
        try {
            await connection.connect();
        }
        finally {
            this.pendingOpenCount -= 1;
        }

        const session = new SshSession(sessionId, connection);
        this.sessions.set(sessionId, session);

        const _logger = $logger.child({ context: "SshSessionManager.open", session_id: sessionId, profile: profile.name });
        _logger.info("ssh session opened", { open_sessions: this.sessions.size });

        return session;
    }

    /**
     * Looks up a session, failing with the list of live ids so the caller can self-correct.
     *
     * @throws {Error} If no session matches `sessionId`.
     */
    require(sessionId: string): SshSession {
        const session = this.sessions.get(sessionId);
        if (session == null) {
            const openIds = Array.from(this.sessions.keys());

            let openSummary = "none";
            if (openIds.length > 0) {
                openSummary = openIds.join(", ");
            }

            throw new Error(`unknown ssh session '${sessionId}' (open sessions: ${openSummary})`);
        }

        return session;
    }

    close(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (session == null) {
            return false;
        }

        session.connection.disconnect();
        this.sessions.delete(sessionId);

        const _logger = $logger.child({ context: "SshSessionManager.close", session_id: sessionId });
        _logger.info("ssh session closed", { open_sessions: this.sessions.size });

        return true;
    }

    closeAll(): void {
        for (const sessionId of Array.from(this.sessions.keys())) {
            this.close(sessionId);
        }
    }

    list(): SshSessionInfo[] {
        return Array.from(this.sessions.values()).map((session) => session.toInfo());
    }

    /** Starts the idle sweeper; the timer is unref'd so it never holds the process open. */
    startIdleSweeper(): void {
        if (this.sweepTimer != null) {
            return;
        }

        this.sweepTimer = setInterval(() => {
            const expiredAt = Date.now() - SESSION_IDLE_TIMEOUT_MS;
            for (const session of Array.from(this.sessions.values())) {
                // A long exec or a large transfer keeps a session busy well past the idle
                // window; reaping it there would abort the operation mid-flight.
                if (session.isBusy == true) {
                    continue;
                }

                if (session.lastUsedAt.getTime() > expiredAt) {
                    continue;
                }

                const _logger = $logger.child({
                    context: "SshSessionManager.sweep",
                    session_id: session.sessionId,
                    idle_ms: Date.now() - session.lastUsedAt.getTime(),
                });
                _logger.info("closing idle ssh session");
                this.close(session.sessionId);
            }
        }, SESSION_SWEEP_INTERVAL_MS);

        this.sweepTimer.unref();
    }

    stopIdleSweeper(): void {
        if (this.sweepTimer == null) {
            return;
        }

        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
    }
}
