// Development-only release checks. Keep this file identical in all five checkouts.
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const CHECKOUTS = ["npm.akms.mcp-db", "npm.akms.mcp-ssh", "npm.akms.mcp-wsl", "npm.akms.mcp-s3", "npm.akms.mcp"];

function parseVersion(value) {
    if(typeof value !== "string") throw new Error("Version must be a SemVer string.");
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
    if(!match || match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) {
        throw new Error(`Invalid SemVer: ${value}`);
    }
    return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") };
}

export function compareVersions(left, right) {
    const a = parseVersion(left), b = parseVersion(right);
    for(let index = 0; index < 3; index++) {
        if(a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
    }
    if(!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
    for(let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
        const x = a.prerelease[index], y = b.prerelease[index];
        if(x === y) continue;
        if(x === undefined || y === undefined) return x === undefined ? -1 : 1;
        const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
        if(numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
        if(numericX !== numericY) return numericX ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

function npmCli() {
    const candidates = [
        path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
        path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    ];
    if(/^(npm|npx)-cli\.js$/.test(path.basename(process.env.npm_execpath ?? ""))) {
        candidates.unshift(path.join(path.dirname(process.env.npm_execpath), "npm-cli.js"));
    }
    for(const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        candidates.push(path.join(directory, process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));
    }
    for(const candidate of candidates) {
        try {
            const resolved = realpathSync(candidate);
            if(resolved.endsWith(".js")) return resolved;
        } catch { /* Try the next npm installation. */ }
    }
    throw new Error("npm was not found; latest could not be checked.");
}

export async function publishedLatest(packageDirectory, name, execute = executeFile) {
    const temporaryRoot = path.resolve(os.tmpdir());
    const cache = await fs.mkdtemp(path.join(temporaryRoot, "akms-release-meta-"));
    try {
        let output;
        try {
            output = await execute(process.execPath, [npmCli(), "view", name, "dist-tags", "--json",
                "--prefer-online", "--prefer-offline=false", "--offline=false", "--fetch-retries=0",
                "--fetch-timeout=15000", "--update-notifier=false", "--cache", cache], {
                cwd: packageDirectory, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
            });
        } catch(error) {
            let code;
            try { code = JSON.parse(error.stdout).error?.code; } catch { /* Non-JSON registry failure. */ }
            throw new Error(`npm latest lookup failed${code ? ` (${code})` : ""}; release blocked.`);
        }
        const tags = JSON.parse(output.stdout);
        if(typeof tags?.latest !== "string") throw new Error("The package exists but has no valid latest dist-tag; release blocked.");
        parseVersion(tags.latest);
        return tags.latest;
    } finally {
        if(path.dirname(cache) !== temporaryRoot || !path.basename(cache).startsWith("akms-release-meta-")) {
            throw new Error("Refusing to remove an unexpected metadata-cache directory.");
        }
        await fs.rm(cache, { recursive: true, force: true });
    }
}

async function filesWithin(directory, prefix = "") {
    const result = [];
    for(const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if(entry.isDirectory()) result.push(...await filesWithin(path.join(directory, entry.name), relative + "/"));
        else if(entry.isFile()) result.push(relative);
        else throw new Error(`Unexpected registration entry: ${relative}`);
    }
    return result.sort();
}

export async function registrationDifferences(workspaceDirectory) {
    const baseline = path.join(workspaceDirectory, CHECKOUTS[0], "src/modules/registration");
    const expectedFiles = await filesWithin(baseline);
    if(expectedFiles.length === 0 || !expectedFiles.includes("runtime.ts")) throw new Error("DB registration baseline is missing or empty.");
    const differences = [];
    for(const checkout of CHECKOUTS.slice(1)) {
        const destination = path.join(workspaceDirectory, checkout, "src/modules/registration");
        let actualFiles;
        try { actualFiles = await filesWithin(destination); }
        catch { differences.push(`${checkout}: registration directory missing or unreadable`); continue; }
        for(const relative of expectedFiles) {
            try {
                let expected = (await fs.readFile(path.join(baseline, relative), "utf8")).replaceAll("\r\n", "\n");
                if(checkout === "npm.akms.mcp" && relative === "prompter.ts") {
                    expected = expected.replaceAll("../manage/prompter", "../launcher/prompter");
                }
                const actual = (await fs.readFile(path.join(destination, relative), "utf8")).replaceAll("\r\n", "\n");
                if(actual !== expected) differences.push(`${checkout}/${relative}: differs from DB`);
            } catch { differences.push(`${checkout}/${relative}: missing or unreadable`); }
        }
        for(const relative of actualFiles) {
            // The launcher owns its client adapters; siblings use modules/manage.
            if(checkout === "npm.akms.mcp" && (relative === "paths.ts" || relative.startsWith("targets/"))) continue;
            if(!expectedFiles.includes(relative)) differences.push(`${checkout}/${relative}: absent from DB baseline`);
        }
    }
    return differences;
}

export async function installedSshProtection(packageDirectory, load = (require) => require("@akms/mcp-ssh")) {
    const require = createRequire(path.join(packageDirectory, "package.json"));
    const ssh = await load(require);
    if(typeof ssh.inspectLocalPath !== "function") throw new Error("Installed @akms/mcp-ssh has no inspectLocalPath export.");
    const temporaryRoot = path.resolve(os.tmpdir());
    const fixture = await fs.mkdtemp(path.join(temporaryRoot, "akms-release-ssh-"));
    try {
        const catalog = path.join(fixture, ".akms", "mcp");
        await fs.mkdir(catalog, { recursive: true });
        for(const access of ["read", "write"]) {
            for(const file of [catalog, path.join(catalog, "registry.json"), path.join(catalog, "backup.json")]) {
                if(ssh.inspectLocalPath(file, access)?.allowed !== false) {
                    throw new Error(`Installed @akms/mcp-ssh ${ssh.SERVER_VERSION ?? "(unknown version)"} does not protect .akms/mcp for ${access}; publish SSH first, raise the WSL dependency floor, and install it locally.`);
                }
            }
            if(ssh.inspectLocalPath(path.join(fixture, "ordinary.txt"), access)?.allowed !== true) {
                throw new Error("SSH protection probe could not verify an ordinary-path control.");
            }
        }
        return `Installed @akms/mcp-ssh ${ssh.SERVER_VERSION ?? "(unknown version)"} blocks registry reads and writes.`;
    } finally {
        if(path.dirname(fixture) !== temporaryRoot || !path.basename(fixture).startsWith("akms-release-ssh-")) {
            throw new Error("Refusing to remove an unexpected SSH-probe directory.");
        }
        await fs.rm(fixture, { recursive: true, force: true });
    }
}

export async function checkRelease(packageDirectory, dependencies = {}) {
    const directory = path.resolve(packageDirectory);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    const execute = dependencies.execute ?? executeFile;
    const checks = [];
    const check = async (name, inspect) => {
        try { checks.push({ name, passed: true, detail: await inspect() }); }
        catch(error) { checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
    };
    await check("working_tree", async () => {
        const result = await execute("git", ["status", "--porcelain"], { cwd: directory, windowsHide: true, timeout: 10000 });
        const changes = result.stdout.trim();
        if(changes) throw new Error(`Working tree is not clean (${changes.split(/\r?\n/).length} status entries). Commit reviewed release changes before publishing.`);
        return "git status --porcelain is empty.";
    });
    await check("version_vs_latest", async () => {
        parseVersion(manifest.version);
        const latest = await (dependencies.latest ?? publishedLatest)(directory, manifest.name);
        if(typeof latest !== "string") throw new Error("npm latest could not be verified; release blocked.");
        if(compareVersions(manifest.version, latest) <= 0) throw new Error(`package.json ${manifest.version} is not greater than npm latest ${latest}.`);
        return `package.json ${manifest.version} > npm latest ${latest}.`;
    });
    if(manifest.name !== "@akms/mcp") {
        await check("server_version", async () => {
            const versionSource = manifest.name === "@akms/mcp-s3" ? "src/profile.ts" : "src/_defs/defaults.ts";
            const defaults = await fs.readFile(path.join(directory, versionSource), "utf8");
            const version = /^\s*export\s+const\s+SERVER_VERSION\s*=\s*["']([^"']+)["']/m.exec(defaults)?.[1];
            if(version !== manifest.version) throw new Error(`SERVER_VERSION ${version ?? "(missing)"} differs from package.json ${manifest.version}.`);
            return `SERVER_VERSION matches ${manifest.version}.`;
        });
    }
    await check("registration_copies", async () => {
        const differences = await registrationDifferences(path.dirname(directory));
        if(differences.length) throw new Error(differences.join("\n"));
        return "All five registration copies match the DB baseline (launcher adapters excluded).";
    });
    if(manifest.name === "@akms/mcp-wsl") {
        await check("wsl_ssh_registry_protection", () => installedSshProtection(directory, dependencies.loadSsh));
    }
    return { packageName: manifest.name, checks, passed: checks.every((item) => item.passed) };
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = await checkRelease(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
        console.log(`Release guard: ${result.packageName}`);
        for(const check of result.checks) console.log(`[${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`);
        process.exitCode = result.passed ? 0 : 1;
    } catch(error) {
        console.error(`Release guard failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
