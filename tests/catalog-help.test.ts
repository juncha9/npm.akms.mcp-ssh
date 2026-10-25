import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("reports the plaintext catalog location in plain help output", () => {
    const result = spawnSync(process.execPath, [path.resolve("lib/cli.js"), "--help"], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    const text = result.stdout + result.stderr;
    expect(text).toContain("Catalog: ~/.akms/mcp/registry.json (or $AKMS_MCP_HOME/registry.json) stores settings and passwords in plaintext.");
    expect(text).not.toContain("\u001b");
});
