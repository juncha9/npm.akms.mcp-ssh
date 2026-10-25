/** Env var overriding the stderr log level ("debug" | "info" | "warn" | "error" | "silent"). */
export const LOG_LEVEL_ENV = "SSH_MCP_LOG_LEVEL";

export const DEFAULT_SSH_PORT = 22;

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

/** stdout / stderr cutoff — roughly 25k tokens of context at worst. */
export const DEFAULT_MAX_OUTPUT_CHARACTERS = 100_000;

export const DEFAULT_MAX_READ_FILE_BYTES = 200_000;

/** ssh2 keepalive so idle sessions survive NAT / firewall timeouts. */
export const KEEPALIVE_INTERVAL_MS = 15_000;

/** Sessions untouched for this long are closed by the sweeper. */
export const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const SESSION_SWEEP_INTERVAL_MS = 60_000;

/** Shutdown waits this long for the sessions and the transport to close, then exits anyway — a dead peer must not keep the process alive. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

/** Emitted after the user command so the session can track `cd` between execs. */
export const CWD_MARKER = "__AKMS_SSH_CWD__";

/** `ssh_list_dir` stops here — a directory with 500k entries would otherwise return megabytes. */
export const MAX_DIRECTORY_ENTRIES = 1_000;

export const SERVER_NAME = "akms-mcp-ssh";

/** Package identity used to recognize existing MCP entries. */
export const PACKAGE_NAME = "@akms/mcp-ssh";

export const SERVER_VERSION = "0.3.2";
