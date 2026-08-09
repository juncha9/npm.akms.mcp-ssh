import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm", "cjs"],
    target: "es2022",
    platform: "node",
    outDir: "lib",
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    minify: false,
    shims: true,
    tsconfig: "./tsconfig.json",
    esbuildOptions(options) {
        options.logOverride = {
            ...options.logOverride,
            "empty-import-meta": "silent",
        };
    },
});
