import { Registry, sessionName } from "./registry";
import { CLIENT_LABELS } from "./types";
import { plainText, writeWrapped } from "./comparison";
import { Prompter, PromptBackError, PromptClosedError } from "./prompter";

/** Review all registry format steps before any saved settings are changed. */
export async function migrationMenu(prompter: Prompter, registry: Registry): Promise<void> {
    try {
        prompter.clearScreen();
        const plan = registry.planMigration();
        prompter.write("Migrate registry\n\n");
        if(!plan.steps.length) { prompter.write("The registry is already in the current format.\n"); await prompter.acknowledge(); return; }
        prompter.write("Steps:\n");
        plan.steps.forEach((step, index) => writeWrapped(prompter, `${index + 1}. ${step.label}`, "  "));
        prompter.write('\nThe registry will record defaultMode: "catalog" for new kinds.\nA kind explicitly switched back to individual entries keeps that choice.\n');
        for(const item of plan.kinds) {
            prompter.write("\n");
            const target = sessionName(item.kind);
            const action = item.status === "catalog" ? `already ${target}; keep` : item.status === "individual" ? "keep explicit per-connection choice (rollback)"
                : item.status === "empty" ? `no connections; future connections use ${target}` : item.status === "blocked" ? "blocked"
                : `per-connection entries -> ${target}${item.status === "pending-runtime" ? " after runtime setup" : ""}`;
            writeWrapped(prompter, `${item.kind.toUpperCase()}: ${item.names.length} connection(s), ${action}`);
            if(item.detail) writeWrapped(prompter, plainText(item.detail), "  ");
            for(const change of item.session?.changes ?? item.changes ?? []) {
                writeWrapped(prompter, `${CLIENT_LABELS[change.client]}${item.status === "pending-runtime" ? " (after Runtime + Sync)" : ""}`, "  ");
                writeWrapped(prompter, `Apply: ${change.add.join(", ") || "none"}`, "    ");
                writeWrapped(prompter, `Remove after verification: ${change.remove.join(", ") || "none"}`, "    ");
                if(change.review.length) writeWrapped(prompter, `Keep for Sync review: ${change.review.map(plainText).join(", ")}`, "    ");
            }
            if(item.session?.custom.length) writeWrapped(prompter, `Custom commands retained for rollback: ${item.session.custom.map(plainText).join(", ")}`, "  ");
        }
        prompter.write("\nThe previous catalog revision is kept in registry.previous.json.\nSession entries contain no connection credentials; those stay in the catalog and its previous revision.\n");
        if(plan.kinds.some(item => item.status === "blocked")) { prompter.write("Resolve blocked kinds before migrating. No migration was applied.\n"); await prompter.acknowledge(); return; }
        if(!await prompter.askYesNo("Migrate registry and apply these changes?", false)) return;
        const results = registry.applyMigration(plan);
        prompter.clearScreen();
        prompter.write(`${registry.formatResults(results, "Registry migration saved.", prompter.paint)}\n`);
        await registry.checkSaved(prompter, plan.kinds.filter(item => item.status !== "individual").flatMap(item => item.names));
        prompter.write("Reconnect affected clients after changes to their server layout. Fix startup failures first.\n");
        await prompter.acknowledge();
    } catch(error) {
        if(error instanceof PromptClosedError) throw error;
        if(error instanceof PromptBackError) return;
        prompter.write(`${error instanceof Error ? error.message : "Could not migrate the registry."}\n`);
        await prompter.acknowledge();
    }
}
