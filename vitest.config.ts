import * as path from 'path';
import { defineConfig } from 'vitest/config';

// Unit-test harness for the pure logic (session naming, ssh config/destination,
// server-config policy, ports, tmux command builders). Node environment only —
// no jsdom, no browser globals. The `vscode` module is not resolvable outside
// the extension host, so we alias it to a tiny stub the tests share.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
    },
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
        },
    },
});
