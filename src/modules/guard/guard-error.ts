import type { GuardVerdict } from "@/_types";

/**
 * Thrown when a guard refuses an operation.
 *
 * A distinct class because callers genuinely branch on it: the tool layer renders a
 * rejection with `formatGuardRejection` and marks it a policy decision, while any other
 * error is an operational failure worth retrying. It carries the verdict so that
 * rendering needs no string parsing.
 */
export class GuardRejectionError extends Error {
    constructor(public readonly verdict: GuardVerdict) {
        super(verdict.reason ?? "rejected by the host profile's guard policy");
        this.name = "GuardRejectionError";
    }
}
