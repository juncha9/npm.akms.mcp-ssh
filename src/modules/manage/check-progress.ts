import type { Writable } from "node:stream";
import { displayWidth, supportsUnicode } from "./prompter";

const ESC = "\u001b";

/** Animated check phases on a terminal; redirected reports remain plain text. */
export class CheckProgress {
    private readonly enabled: boolean;
    private readonly color: boolean;
    private readonly unicode = supportsUnicode();
    private readonly frames = this.unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
    private timer: ReturnType<typeof setInterval> | null = null;
    private label: string | null = null;
    private startedAt = 0;
    private frame = 0;

    constructor(private readonly output: Writable) {
        this.enabled = (output as Writable & { isTTY?: boolean }).isTTY === true && process.env.TERM !== "dumb";
        this.color = process.env.NO_COLOR == null;
    }

    /** Advancing means the preceding phase actually completed successfully. */
    start(label: string): void {
        if (this.enabled == false) {
            return;
        }
        this.finish(true);
        this.label = label;
        this.startedAt = Date.now();
        this.frame = 0;
        this.draw(this.frames[0], 36);
        this.timer = setInterval(() => {
            this.frame = (this.frame + 1) % this.frames.length;
            this.draw(this.frames[this.frame], 36);
        }, 80);
        this.timer.unref();
    }

    /** Leaves the completed phase and its duration visible. */
    finish(ok: boolean): void {
        if (this.label == null) {
            return;
        }
        this.clearTimer();
        const symbol = ok ? (this.unicode ? "✔" : "OK") : (this.unicode ? "✖" : "X");
        this.draw(symbol, ok ? 32 : 31);
        this.output.write("\n");
        this.label = null;
    }

    /** Clears an unfinished phase without recording a result. */
    stop(): void {
        this.clearTimer();
        if (this.label != null) {
            this.output.write(`\r${ESC}[2K`);
            this.label = null;
        }
    }

    private clearTimer(): void {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private draw(symbol: string, color: number): void {
        const columns = (this.output as Writable & { columns?: number }).columns;
        const width = Math.max(0, (columns != null && columns > 0 ? columns : 80) - 1);
        const elapsed = `  ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
        const prefix = `  ${symbol} `;
        const labelWidth = Math.min(48, Math.max(0, width - displayWidth(prefix) - displayWidth(elapsed)));
        const label = this.fit(this.label ?? "", labelWidth);
        const line = this.fit(`${prefix}${label}${" ".repeat(labelWidth - displayWidth(label))}${elapsed}`, width);
        const painted = this.color ? `${ESC}[${color}m${line}${ESC}[39m` : line;
        this.output.write(`\r${ESC}[2K${painted}`);
    }

    private fit(text: string, width: number): string {
        if (displayWidth(text) <= width) {
            return text;
        }
        if (width < 1) {
            return "";
        }
        let result = "";
        let used = 0;
        for (const character of text) {
            const size = displayWidth(character);
            if (used + size > width - 1) {
                break;
            }
            result += character;
            used += size;
        }
        return `${result}${this.unicode ? "…" : "~"}`;
    }
}
