import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    resolve: {
        // The npm package only contains Obsidian typings.  Tests provide a
        // lightweight runtime stub because the real API exists inside Obsidian.
        alias: {
            obsidian: path.resolve(__dirname, 'src/obsidian-test-stub.ts'),
        },
    },
    test: {
        environment: 'node',
        globals: true,
    },
});
