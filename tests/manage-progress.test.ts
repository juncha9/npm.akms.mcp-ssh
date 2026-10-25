import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckProgress } from "@/modules/manage/check-progress";
import { displayWidth } from "@/modules/manage/prompter";

function terminal(columns = 80, isTTY = true) {
    const output = Object.assign(new PassThrough(), { isTTY, columns });
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    return { output, chunks, screen: () => chunks.join("") };
}

function plain(text: string): string {
    return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("TERM", "xterm");
    vi.stubEnv("WT_SESSION", "test-terminal");
    vi.stubEnv("NO_COLOR", undefined);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe("connection check progress", () => {
    it("animates elapsed time, retains completed phases and stops after failure", () => {
        const screen = terminal();
        const progress = new CheckProgress(screen.output);
        progress.start("SSH tunnel");
        const firstFrame = screen.chunks[0];
        vi.advanceTimersByTime(240);
        expect(screen.chunks.at(-1)).not.toBe(firstFrame);
        expect(plain(screen.chunks.at(-1)!)).toContain("0.2s");

        progress.start("Database response");
        expect(plain(screen.screen())).toMatch(/✔ SSH tunnel +0.2s\n/);
        expect(screen.screen()).toContain("\u001b[32m");
        vi.advanceTimersByTime(160);
        progress.finish(false);
        expect(plain(screen.screen())).toMatch(/✖ Database response +0.2s\n$/);
        expect(screen.screen()).toContain("\u001b[31m");
        expect(vi.getTimerCount()).toBe(0);
        const completed = screen.screen();
        vi.advanceTimersByTime(1000);
        expect(screen.screen()).toBe(completed);
    });

    it("keeps each frame within the current terminal width, including wide text", () => {
        const screen = terminal(28);
        const progress = new CheckProgress(screen.output);
        progress.start("데이터베이스 응답 확인 ".repeat(8));
        expect(displayWidth(plain(screen.chunks.at(-1)!).replace(/\r/g, ""))).toBeLessThan(28);
        expect(plain(screen.screen())).toContain("…");
        screen.output.columns = 20;
        vi.advanceTimersByTime(80);
        expect(displayWidth(plain(screen.chunks.at(-1)!).replace(/\r/g, ""))).toBeLessThan(20);
        progress.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("produces no animation or timers for pipes and dumb terminals", () => {
        const pipe = terminal(80, false);
        const progress = new CheckProgress(pipe.output);
        progress.start("Connecting");
        progress.finish(true);
        expect(pipe.screen()).toBe("");
        vi.stubEnv("TERM", "dumb");
        const screen = terminal();
        const dumb = new CheckProgress(screen.output);
        dumb.start("Connecting");
        dumb.stop();
        expect(screen.screen()).toBe("");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("honours NO_COLOR and can stop an unfinished check without marking it successful", () => {
        vi.stubEnv("NO_COLOR", "1");
        const screen = terminal();
        const progress = new CheckProgress(screen.output);
        progress.start("Connecting");
        progress.stop();
        progress.stop();
        expect(screen.screen()).not.toMatch(/\u001b\[[0-9;]*m/);
        expect(screen.screen()).not.toContain("✔");
        expect(vi.getTimerCount()).toBe(0);
        const stopped = screen.screen();
        vi.advanceTimersByTime(1000);
        expect(screen.screen()).toBe(stopped);
    });
});
