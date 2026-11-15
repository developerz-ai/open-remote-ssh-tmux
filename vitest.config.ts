import * as path from 'path';
import { defineConfig } from 'vitest/config';

// Two projects, one shared `vscode` alias (`extends: true` inherits it):
//  - `unit` — the pure logic (session naming, ssh config/destination, server-config
//    policy, ports, tmux command builders). Node environment only — no jsdom, no browser
//    globals. The `vscode` module is not resolvable outside the extension host, so we
//    alias it to a tiny stub the tests share. This is `npm test`.
//  - `integration` — `test/integration/**/*.itest.ts`, against REAL tmux over real ssh2
//    in the docker rig (`test/rig/`). Never part of `npm test`: it needs docker and the
//    environment `test/rig/run.sh` exports, so run it through `npm run test:tmux`.
export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
        },
    },
    test: {
        // `npm run test:coverage` (unit project only). Every `src/` file is reported so
        // untested upstream code shows up as such; only the fork's own modules are gated.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.d.ts'],
            reporter: ['text-summary', 'text'],
            // A ratchet: each is the measured baseline rounded down. Raise them as tests
            // land; never lower one to make a change pass.
            thresholds: {
                'src/tmux/**': { statements: 96, branches: 94, functions: 94, lines: 97 },
                'src/clipboard/**': { statements: 34, branches: 33, functions: 39, lines: 35 },
                'src/common/**': { statements: 92, branches: 76, functions: 93, lines: 92 },
            },
        },
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['test/**/*.test.ts'],
                    environment: 'node',
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['test/integration/**/*.itest.ts'],
                    environment: 'node',
                    // Real network round-trips and real tmux servers: generous, but finite,
                    // so a hung remote fails the test instead of the CI job's wall clock.
                    testTimeout: 60_000,
                    hookTimeout: 60_000,
                },
            },
        ],
    },
});
