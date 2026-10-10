import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Absolute path of an executable on `PATH`, or null. On Windows only `PATHEXT` suffixes are
 * tried — npm drops an extensionless POSIX shell script next to every `.cmd` shim, and that
 * file exists but cannot be launched.
 */
export function findExecutable(name: string): string | null {
    const searchPath = process.env.PATH ?? "";
    const directories = searchPath.split(path.delimiter).filter((directory) => directory !== "");

    let suffixes = [""];
    if (process.platform === "win32") {
        const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
        suffixes = pathExt.split(";").filter((suffix) => suffix !== "");
    }

    for (const directory of directories) {
        for (const suffix of suffixes) {
            const candidate = path.join(directory, `${name}${suffix}`);
            if (fs.existsSync(candidate) == true && fs.statSync(candidate).isFile() == true) {
                return candidate;
            }
        }
    }

    return null;
}

/** Expands a leading `~` to the local home directory and returns an absolute path. */
export function expandHomePath(inputPath: string): string {
    let expanded = inputPath;
    if (inputPath === "~") {
        expanded = os.homedir();
    }
    else if (inputPath.startsWith("~/") == true || inputPath.startsWith("~\\") == true) {
        expanded = path.join(os.homedir(), inputPath.slice(2));
    }

    return path.resolve(expanded);
}

/** True for POSIX absolute remote paths — the only form the path guard can reason about. */
export function isAbsoluteRemotePath(remotePath: string): boolean {
    return remotePath.startsWith("/");
}

/** Collapses `.`, `..` and duplicate slashes using POSIX rules, whatever the local OS is. */
export function normalizeRemotePath(remotePath: string): string {
    return path.posix.normalize(remotePath);
}

/** True when `candidate` is `allowedPrefix` itself or sits underneath it. */
export function isRemotePathWithin(candidate: string, allowedPrefix: string): boolean {
    const normalizedCandidate = normalizeRemotePath(candidate);
    const normalizedPrefix = normalizeRemotePath(allowedPrefix).replace(/\/+$/, "");

    if (normalizedPrefix === "" || normalizedPrefix === "/") {
        return true;
    }

    if (normalizedCandidate === normalizedPrefix) {
        return true;
    }

    return normalizedCandidate.startsWith(`${normalizedPrefix}/`);
}
