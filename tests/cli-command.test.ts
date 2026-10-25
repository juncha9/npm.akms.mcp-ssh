import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROJECT_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_TEXT = 'model = "test-model"\n';

let homeDirectory = "";
let configPath = "";

beforeEach(() => {
    homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ssh-cli-"));
    configPath = path.join(homeDirectory, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, CONFIG_TEXT);
});

afterEach(() => {
    fs.rmSync(homeDirectory, { recursive: true, force: true });
});

function runCli(args: string[]) {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        const normalized = name.toUpperCase();
        if (["HOME", "USERPROFILE", "APPDATA"].includes(normalized) == true || normalized.startsWith("SSH_") == true) {
            continue;
        }
        env[name] = value;
    }
    env.AKMS_MCP_HOME = homeDirectory;
    env.CODEX_HOME = path.join(homeDirectory, ".codex");
    env.HOME = homeDirectory;
    env.USERPROFILE = homeDirectory;
    env.APPDATA = path.join(homeDirectory, "AppData", "Roaming");
    env.SSH_MCP_LOG_LEVEL = "silent";

    return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        cwd: PROJECT_DIRECTORY,
        env: env,
        input: "q\n",
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    });
}

describe("CLI configuration command", () => {
    it("advertises config in help", () => {
        const result = runCli(["--help"]);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("akms-mcp-ssh config [--target <client>]");
        expect(result.stderr).not.toContain("setup");
    }, 15_000);

    it("opens the menu without changing settings before registration", () => {
        const result = runCli(["config", "--target", "codex"]);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("No AI services registered");
        expect(result.stdout).toContain("Register");
        expect(fs.readFileSync(configPath, "utf8")).toBe(CONFIG_TEXT);
    }, 15_000);

    it("rejects setup instead of opening the manager or starting the MCP server", () => {
        const result = runCli(["setup", "--target", "codex"]);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("The setup command has been removed. Use akms-mcp-ssh config.");
        expect(fs.readFileSync(configPath, "utf8")).toBe(CONFIG_TEXT);
    }, 15_000);

    it("points an unconfigured connection check to config", () => {
        const result = runCli(["--check"]);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("or run: akms-mcp-ssh config");
        expect(result.stdout).not.toContain("setup");
    }, 15_000);
});
