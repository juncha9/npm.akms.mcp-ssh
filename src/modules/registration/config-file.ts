import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function readExisting(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf8");
    }
    catch(error) {
        if((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

/** Build a complete replacement beside the config, then commit it with one rename. */
export function updateConfigFile(filePath: string, update: (text: string) => string, options: { mode?: number; beforeCommit?: (before: string | null) => void } = {}): void {
    let destination = filePath;
    let symbolicLink = false;
    try {
        symbolicLink = fs.lstatSync(filePath).isSymbolicLink();
    }
    catch(error) {
        if((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    // A dangling symlink is an error; never replace the link with a new regular file.
    if(symbolicLink) {
        destination = fs.realpathSync(filePath);
    }
    const before = readExisting(destination);
    const updated = update(before ?? "");
    if(before === updated) return;
    if(before != null) {
        fs.accessSync(destination, fs.constants.W_OK);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    const mode = options.mode ?? (before == null ? 0o600 : fs.statSync(destination).mode & 0o777);
    let descriptor: number | undefined;
    let ownsTemporary = false;
    try {
        descriptor = fs.openSync(temporary, "wx", mode);
        ownsTemporary = true;
        fs.writeFileSync(descriptor, updated, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        if(readExisting(destination) !== before) {
            throw new Error("The config changed while saving; reload it and try again.");
        }
        options.beforeCommit?.(before);
        if(readExisting(destination) !== before) throw new Error("The config changed while saving; reload it and try again.");
        fs.renameSync(temporary, destination);
        ownsTemporary = false;
    }
    finally {
        try {
            if(descriptor != null) {
                fs.closeSync(descriptor);
            }
        }
        finally {
            if(ownsTemporary) {
                fs.unlinkSync(temporary);
            }
        }
    }
}
