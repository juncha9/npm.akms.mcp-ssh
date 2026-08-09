/** Outcome of one remote command. */
export interface SshExecResult {
    stdout: string;
    stderr: string;
    /** Remote process exit status; null when the process was killed by a signal. */
    exitCode: number | null;
    /** Signal name that killed the remote process, e.g. "TERM". */
    signal?: string;
    /** True when the local timeout fired before the remote process finished. */
    timedOut: boolean;
    /** True when stdout or stderr hit `maxOutputCharacters` and was cut. */
    truncated: boolean;
    /** Working directory after the command ran; only tracked for session-bound execs. */
    cwd?: string;
    durationMs: number;
}

/** Live session as reported by `ssh_list_sessions`. */
export interface SshSessionInfo {
    sessionId: string;
    profileName: string;
    host: string;
    username: string;
    cwd: string;
    /** ISO-8601 timestamps. */
    openedAt: string;
    lastUsedAt: string;
    execCount: number;
}

/** One entry of an SFTP directory listing. */
export interface SshRemoteEntry {
    name: string;
    type: "file" | "directory" | "symlink" | "other";
    sizeBytes: number;
    /** Octal permission string, e.g. "0644". */
    mode: string;
    modifiedAt: string;
}

/** Verdict from the command / path guards. */
export interface GuardVerdict {
    allowed: boolean;
    /** Human-readable rejection cause; only set when `allowed` is false. */
    reason?: string;
    /** The command segment or path that tripped the rule. */
    offendingText?: string;
}
