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
