import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const retryableErrors = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

/** Allow transient Windows file locks to clear without blocking process exit callbacks. */
export async function removeTempDirectory(directory: string, prefix: string): Promise<void> {
    const target = path.resolve(directory);
    if(!prefix || path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) {
        throw new Error("Unexpected cleanup target");
    }
    // Share one retry budget for the whole tree. rm's own retries are per path,
    // so a persistent child lock would otherwise multiply the parent's wait.
    for(let retry = 0; ; retry++) {
        try {
            await rm(target, { recursive: true, force: true, maxRetries: 0 });
            return;
        } catch(error) {
            if(retry === 10 || !retryableErrors.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
            // Ten retries add 5.5 seconds of backoff; persistent errors still fail.
            await delay(100 * (retry + 1));
        }
    }
}
