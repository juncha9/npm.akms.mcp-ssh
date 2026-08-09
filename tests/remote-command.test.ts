import { describe, expect, it } from "vitest";

import { CWD_MARKER } from "@/_defs";
import { quoteShellArgument, truncateOutput } from "@/_libs";
import { buildRemoteCommand, extractCwdMarker } from "@/modules/ssh";

describe("buildRemoteCommand", () => {
    it("passes the command through untouched when there is no cwd and no tracking", () => {
        expect(buildRemoteCommand("ls -la", undefined, false)).toBe("ls -la");
    });

    it("prefixes a quoted cd when a cwd is given", () => {
        const built = buildRemoteCommand("ls", "/opt/app", false);
        expect(built.startsWith(`cd '/opt/app'`)).toBe(true);
        expect(built.endsWith("ls")).toBe(true);
    });

    it("escapes single quotes in the cwd", () => {
        const built = buildRemoteCommand("ls", "/opt/it's", false);
        expect(built).toContain(`'/opt/it'\\''s'`);
    });

    it("replays the command's exit status after printing the cwd marker", () => {
        const built = buildRemoteCommand("false", undefined, true);
        const lines = built.split("\n");

        expect(lines[0]).toBe("false");
        expect(lines[1]).toBe("__akms_exit=$?");
        expect(lines[2]).toContain(CWD_MARKER);
        expect(lines[3]).toBe("exit $__akms_exit");
    });
});

describe("extractCwdMarker", () => {
    it("splits the trailing marker off and keeps the output intact", () => {
        const raw = `total 0\ndrwxr-xr-x 2 root root\n${CWD_MARKER}/opt/app`;
        const parsed = extractCwdMarker(raw);

        expect(parsed.cwd).toBe("/opt/app");
        expect(parsed.output).toBe("total 0\ndrwxr-xr-x 2 root root");
    });

    it("returns the output unchanged when no marker is present", () => {
        const parsed = extractCwdMarker("plain output");
        expect(parsed.cwd).toBeUndefined();
        expect(parsed.output).toBe("plain output");
    });

    it("uses the last marker when the output happens to contain one", () => {
        const raw = `${CWD_MARKER}/fake\nreal output\n${CWD_MARKER}/opt/real`;
        const parsed = extractCwdMarker(raw);
        expect(parsed.cwd).toBe("/opt/real");
    });
});

describe("truncateOutput", () => {
    it("leaves short output alone", () => {
        const result = truncateOutput("hello", 100);
        expect(result.truncated).toBe(false);
        expect(result.text).toBe("hello");
    });

    it("cuts long output and reports how much was dropped", () => {
        const result = truncateOutput("a".repeat(50), 10);
        expect(result.truncated).toBe(true);
        expect(result.text.startsWith("a".repeat(10))).toBe(true);
        expect(result.text).toContain("truncated 40 characters of 50");
    });
});

describe("quoteShellArgument", () => {
    it("wraps a plain path in single quotes", () => {
        expect(quoteShellArgument("/var/log")).toBe(`'/var/log'`);
    });

    it("neutralizes an embedded single quote", () => {
        expect(quoteShellArgument(`a'b`)).toBe(`'a'\\''b'`);
    });
});
