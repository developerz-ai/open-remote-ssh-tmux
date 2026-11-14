import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatherIdentityFiles } from '../../src/ssh/identityFiles';
import Log from '../../src/common/logger';

const execFile = promisify(cp.execFile);

// An agent that accepts the request and never answers — a wedged ssh-agent, or a
// forwarded agent socket whose other end is gone.
const { agentMode } = vi.hoisted(() => ({ agentMode: { current: 'hang' as 'hang' | 'reset' } }));
vi.mock('ssh2', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ssh2')>();
    return {
        ...actual,
        utils: actual.utils,
        OpenSSHAgent: vi.fn().mockImplementation(function () {
            return {
                getIdentities: (cb: (err: Error | undefined, keys?: unknown[]) => void) => {
                    if (agentMode.current === 'reset') {
                        cb(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
                    }
                },
            };
        }),
    };
});

function lines(log: Log): string[] {
    return (log as unknown as { output: { lines: string[] } }).output.lines;
}

// The agent lookup ran with no deadline, so a hung agent hung the whole connect
// before a single auth method was tried. And an agent that failed (ECONNRESET in
// field logs) was logged at Error although auth then went on and succeeded.
describe('gatherIdentityFiles: ssh-agent lookup', () => {
    let tmpDir: string | undefined;

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    async function plainKey(): Promise<string> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-agent-test-'));
        const keyPath = path.join(tmpDir, 'id_ed25519');
        await execFile('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', '', '-q']);
        return keyPath;
    }

    it('continues with the file identities when the agent never answers', async () => {
        agentMode.current = 'hang';
        const keyPath = await plainKey();
        const log = new Log('test');

        const keys = await gatherIdentityFiles([keyPath], '/agent.sock', false, log, 50);

        expect(keys.map(k => k.filename)).toEqual([keyPath]);
        expect(lines(log).some(l => l.startsWith('[Info') && l.includes('OpenSSH agent'))).toBe(true);
    });

    it('logs an agent failure at Info, not Error', async () => {
        agentMode.current = 'reset';
        const keyPath = await plainKey();
        const log = new Log('test');

        await gatherIdentityFiles([keyPath], '/agent.sock', false, log);

        expect(lines(log).some(l => l.startsWith('[Error'))).toBe(false);
        expect(lines(log).some(l => l.startsWith('[Info') && l.includes('ECONNRESET'))).toBe(true);
    });
});
