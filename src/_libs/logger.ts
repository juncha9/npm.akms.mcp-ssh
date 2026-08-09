import { LOG_LEVEL_ENV } from "@/_defs";

export type LogLevel = "silent" | "debug" | "info" | "warn" | "error";

export interface Logger {
    /** Returns a logger that appends `meta` to every record it writes. */
    child(meta: Record<string, unknown>): Logger;
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(error: unknown, message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
    silent: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
};

/** Meta keys whose values never reach the log output. */
const SECRET_META_KEYS = ["password", "passphrase", "privatekey", "privatekeypath", "secret", "token"];

function resolveThreshold(): LogLevel {
    const configured = process.env[LOG_LEVEL_ENV];
    if (configured == null) {
        return "info";
    }

    // Own-property check: a plain `LEVEL_WEIGHTS[x] == null` test walks the prototype, so
    // SSH_MCP_LOG_LEVEL=constructor would pass validation and disable all filtering.
    const normalized = configured.toLowerCase() as LogLevel;
    if (Object.hasOwn(LEVEL_WEIGHTS, normalized) == false) {
        return "info";
    }

    return normalized;
}

function maskMeta(meta: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (SECRET_META_KEYS.includes(key.toLowerCase()) == true) {
            masked[key] = "***";
            continue;
        }

        masked[key] = value;
    }

    return masked;
}

/**
 * Writes to stderr only. stdout carries the MCP JSON-RPC stream over stdio transport,
 * so a single stray `console.log` corrupts the protocol and kills the session.
 */
function write(level: LogLevel, message: string, meta: Record<string, unknown>): void {
    const threshold = resolveThreshold();
    if (threshold === "silent") {
        return;
    }

    if (LEVEL_WEIGHTS[level] < LEVEL_WEIGHTS[threshold]) {
        return;
    }

    const timestamp = new Date().toISOString();
    const masked = maskMeta(meta);

    let line = `${timestamp} [${level}] ${message}`;
    if (Object.keys(masked).length > 0) {
        line += ` ${JSON.stringify(masked)}`;
    }

    process.stderr.write(`${line}\n`);
}

function createLogger(boundMeta: Record<string, unknown>): Logger {
    return {
        child(meta: Record<string, unknown>): Logger {
            return createLogger({ ...boundMeta, ...meta });
        },
        debug(message: string, meta?: Record<string, unknown>): void {
            write("debug", message, { ...boundMeta, ...meta });
        },
        info(message: string, meta?: Record<string, unknown>): void {
            write("info", message, { ...boundMeta, ...meta });
        },
        warn(message: string, meta?: Record<string, unknown>): void {
            write("warn", message, { ...boundMeta, ...meta });
        },
        error(error: unknown, message: string, meta?: Record<string, unknown>): void {
            const errorMeta: Record<string, unknown> = { ...boundMeta, ...meta };
            if (error instanceof Error) {
                errorMeta.error_name = error.name;
                errorMeta.error_message = error.message;
                errorMeta.stack = error.stack;
            }
            else if (error != null) {
                errorMeta.error_message = String(error);
            }

            write("error", message, errorMeta);
        },
    };
}

export const $logger = createLogger({});
