import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCliCommand, toClaudeAddJsonPayload } from "@/modules/manage/targets/claude-code";

/**
 * The template npm writes for every global bin on Windows (`claude.cmd` included). It
 * re-expands `%*` into a second command line, which is what makes the quoting hard.
 */
const NPM_SHIM_TEMPLATE = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    "IF EXIST \"%dp0%\\node.exe\" (",
    "  SET \"_prog=%dp0%\\node.exe\"",
    ") ELSE (",
    "  SET \"_prog=node\"",
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\echo-args.js\" %*",
    "",
].join("\r\n");

let shimDirectory = "";

beforeAll(() => {
    // A space in the path, as under "Program Files".
    shimDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp ssh shim-"));
    fs.writeFileSync(path.join(shimDirectory, "echo-args.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    fs.writeFileSync(path.join(shimDirectory, "fake-claude.cmd"), NPM_SHIM_TEMPLATE);
});

afterAll(() => {
    fs.rmSync(shimDirectory, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("runCliCommand through an npm .cmd shim", () => {
    it("delivers a JSON payload full of shell metacharacters byte for byte", () => {
        const payload = toClaudeAddJsonPayload({
            command: "cmd",
            args: ["/c", "npx", "-y", "@akms/mcp-ssh"],
            env: {
                SSH_KEY: "C:\\Users\\me\\.ssh\\id_ed25519",
                SSH_PROXY_COMMAND: "ssh -W %h:%p bastion & echo pwned | more",
                SSH_DESCRIPTION: "it's \"quoted\" ^caret !bang (paren) <angle> 100%",
                SSH_CWD: "C:\\trailing\\",
            },
        });
        const args = ["mcp", "add-json", "ssh-prod", payload, "-s", "user"];

        const result = runCliCommand(path.join(shimDirectory, "fake-claude.cmd"), args);

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(args);
    });
});
