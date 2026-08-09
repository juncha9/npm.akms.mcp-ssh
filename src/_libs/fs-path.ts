import os from "node:os";
import path from "node:path";

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
