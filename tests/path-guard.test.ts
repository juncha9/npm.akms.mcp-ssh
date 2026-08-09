import { describe, expect, it } from "vitest";

import { isRemotePathWithin } from "@/_libs";
import { inspectRemotePath } from "@/modules/guard";

import { createPolicy } from "./_helpers";

describe("isRemotePathWithin", () => {
    it("matches the prefix itself and its children", () => {
        expect(isRemotePathWithin("/var/log", "/var/log")).toBe(true);
        expect(isRemotePathWithin("/var/log/nginx/access.log", "/var/log")).toBe(true);
    });

    it("does not match a sibling sharing the prefix string", () => {
        expect(isRemotePathWithin("/var/log-backup", "/var/log")).toBe(false);
    });

    it("resolves .. before comparing", () => {
        expect(isRemotePathWithin("/var/log/../../etc/passwd", "/var/log")).toBe(false);
    });

    it("treats / as containing everything", () => {
        expect(isRemotePathWithin("/etc/passwd", "/")).toBe(true);
    });
});

describe("inspectRemotePath — readonly", () => {
    it("rejects writes on a read-only profile", () => {
        const verdict = inspectRemotePath("/opt/app/config.json", createPolicy({ readonly: true }), "write");
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("read-only");
    });

    it("still allows reads on a read-only profile", () => {
        const verdict = inspectRemotePath("/opt/app/config.json", createPolicy({ readonly: true }), "read");
        expect(verdict.allowed).toBe(true);
    });
});

describe("inspectRemotePath — allowedPaths", () => {
    const policy = createPolicy({ allowedPaths: ["/var/log", "/opt/app"] });

    it("allows a path inside an allowed prefix", () => {
        expect(inspectRemotePath("/var/log/syslog", policy, "read").allowed).toBe(true);
    });

    it("rejects a path outside every prefix", () => {
        const verdict = inspectRemotePath("/etc/shadow", policy, "read");
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("allowedPaths");
    });

    it("rejects a traversal that escapes the prefix", () => {
        const verdict = inspectRemotePath("/var/log/../../etc/shadow", policy, "read");
        expect(verdict.allowed).toBe(false);
    });

    it("requires an absolute path so the prefix check cannot be bypassed", () => {
        const verdict = inspectRemotePath("syslog", policy, "read");
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain("absolute");
    });

    it("accepts a relative path when the profile sets no allowedPaths", () => {
        expect(inspectRemotePath("syslog", createPolicy(), "read").allowed).toBe(true);
    });
});

describe("inspectRemotePath — empty input", () => {
    it("rejects an empty path", () => {
        expect(inspectRemotePath("  ", createPolicy(), "read").allowed).toBe(false);
    });
});
