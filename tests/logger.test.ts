import { afterEach, describe, expect, it, vi } from "vitest";

import { $logger } from "@/_libs";

const ORIGINAL_LOG_LEVEL = process.env.SSH_MCP_LOG_LEVEL;

afterEach(() => {
    // Assigning `undefined` would store the literal string "undefined", leaving the env
    // dirtier than the suite found it.
    if (ORIGINAL_LOG_LEVEL == null) {
        delete process.env.SSH_MCP_LOG_LEVEL;
    }
    else {
        process.env.SSH_MCP_LOG_LEVEL = ORIGINAL_LOG_LEVEL;
    }

    vi.restoreAllMocks();
});

/** Captures everything the logger writes during `run`. */
function captureStderr(run: () => void): string {
    let captured = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        captured += String(chunk);
        return true;
    });

    run();
    spy.mockRestore();
    return captured;
}

describe("log level resolution", () => {
    it("writes info and above at the default level", () => {
        process.env.SSH_MCP_LOG_LEVEL = "info";
        const output = captureStderr(() => {
            $logger.debug("debug line");
            $logger.info("info line");
        });

        expect(output).not.toContain("debug line");
        expect(output).toContain("info line");
    });

    it("writes nothing when silenced", () => {
        process.env.SSH_MCP_LOG_LEVEL = "silent";
        const output = captureStderr(() => {
            $logger.error(new Error("boom"), "error line");
        });

        expect(output).toBe("");
    });

    // `LEVEL_WEIGHTS[x] == null` walked the prototype chain, so this value passed
    // validation and then compared as undefined — disabling filtering entirely.
    it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "nonsense"])(
        "falls back to info for the invalid level %s",
        (level) => {
            process.env.SSH_MCP_LOG_LEVEL = level;
            const output = captureStderr(() => {
                $logger.debug("debug line");
                $logger.info("info line");
            });

            expect(output).not.toContain("debug line");
            expect(output).toContain("info line");
        }
    );
});

describe("secret masking", () => {
    it("masks credential keys in the metadata", () => {
        process.env.SSH_MCP_LOG_LEVEL = "info";
        const output = captureStderr(() => {
            $logger.info("connecting", {
                host: "10.0.0.5",
                password: "hunter2",
                passphrase: "secret-phrase",
                privateKeyPath: "/home/me/.ssh/id_ed25519",
                token: "abc123",
            });
        });

        expect(output).toContain("10.0.0.5");
        expect(output).not.toContain("hunter2");
        expect(output).not.toContain("secret-phrase");
        expect(output).not.toContain("id_ed25519");
        expect(output).not.toContain("abc123");
    });

    it("keeps bound child metadata across calls", () => {
        process.env.SSH_MCP_LOG_LEVEL = "info";
        const output = captureStderr(() => {
            const scoped = $logger.child({ context: "test", session_id: "box#1" });
            scoped.info("bound");
        });

        expect(output).toContain("box#1");
        expect(output).toContain("test");
    });
});
