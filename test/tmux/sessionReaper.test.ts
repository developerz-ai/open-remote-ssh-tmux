import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_REAP_GRACE_SECONDS, SessionReaper } from '../../src/tmux/sessionReaper';
import { buildKillSession, sessionName } from '../../src/tmux/tmuxSession';

// The reaper is the anti-zombie backstop that complements the terminal provider:
// on a successful connect (and on manual refresh) it lists the remote's tmux
// sessions and kills exactly the *dead, detached* ones THIS extension owns — the
// corpses left when a pane's process exits but the session lingers (`remain-on-exit`),
// which the provider's create/close path can't clean up because no client is around
// to see them. The kill DECISION lives in the session model (`shouldReap`, 02); this
// module only orchestrates list -> parse -> decide -> kill. It is dependency-inverted
// (injected exec / clock / log, no ssh2 / vscode), so the whole contract is
// unit-testable here. It is deliberately conservative: an attached session, a session
// with a live pane (a detached long-running task — the point of the fork), a foreign
// session, or a just-created one are all left strictly untouched; a probe failure
// degrades to "reaped nothing" and never throws (reaping must never break the connect).

const HOST = 'example.com';
const WS = '/home/user/proj';

/** Deterministic owned session name for a slot in the test workspace. */
const ours = (slot: number): string => sessionName(HOST, WS, slot);

/** A fixed "now" (epoch seconds). Rows default to `OLD`, safely past any grace. */
const NOW = 1_700_000_000;
const OLD = NOW - 3600;

/**
 * A `tmux list-sessions -F` stdout line: `<name> <attached> <windows> <created> <paneDead>`.
 * A reapable corpse is detached with a dead pane (`paneDead: true`); a live session
 * has `paneDead: false`. `windows` is ≥1 for any real session and is never the reap gate.
 */
const row = (
    name: string,
    attached: boolean,
    opts: { windows?: number; paneDead?: boolean; created?: number } = {},
): string => {
    const windows = opts.windows ?? 1;
    const created = opts.created ?? OLD;
    return `${name} ${attached ? 1 : 0} ${windows} ${created} ${opts.paneDead ? 1 : 0}`;
};

/**
 * An exec that answers `list-sessions` with the given rows and `kill-session` with
 * success, recording every command. A test can force a rejection on the list probe
 * or on the kill of a specific session (models a dead channel — the real exec
 * surfaces no exit code, only stdout/stderr or a rejection).
 */
function fakeExec(opts: { list?: string[]; throwOnList?: boolean; throwKillFor?: string } = {}) {
    const listOut = (opts.list ?? []).join('\n');
    return vi.fn(async (command: string) => {
        if (command.includes('list-sessions')) {
            if (opts.throwOnList) {
                throw new Error('channel closed');
            }
            return { stdout: listOut, stderr: '' };
        }
        if (command.includes('kill-session')) {
            if (opts.throwKillFor !== undefined && command.includes(opts.throwKillFor)) {
                throw new Error('kill failed');
            }
            return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    });
}

function makeReaper(over: { exec?: ReturnType<typeof fakeExec>; now?: number; minAgeSeconds?: number } = {}) {
    const exec = over.exec ?? fakeExec();
    const log = { info: vi.fn(), trace: vi.fn() };
    const reaper = new SessionReaper({
        exec,
        now: () => over.now ?? NOW,
        log,
        minAgeSeconds: over.minAgeSeconds,
    });
    return { reaper, exec, log };
}

/** The `kill-session` commands an exec received, in call order. */
const killCommands = (exec: ReturnType<typeof fakeExec>): string[] =>
    exec.mock.calls.map(call => call[0]).filter(command => command.includes('kill-session'));

describe('reap — selection (list -> parse -> shouldReap -> kill)', () => {
    it('kills exactly the dead, detached session we own; leaves attached + foreign', async () => {
        const exec = fakeExec({
            list: [
                row(ours(0), false, { paneDead: true }),  // ours, detached, dead pane  -> reap
                row(ours(1), true, { paneDead: true }),   // ours, attached (dead pane) -> keep
                row('main', false, { paneDead: true }),   // foreign, dead pane         -> keep (not ours)
            ],
        });
        const { reaper, log } = makeReaper({ exec });

        const reaped = await reaper.reap();

        expect(killCommands(exec)).toEqual([buildKillSession(ours(0))]);
        expect(reaped).toBe(1);
        expect(log.info).toHaveBeenCalledTimes(1);
    });

    it('never kills a live detached session (a detached long-running task)', async () => {
        const exec = fakeExec({ list: [row(ours(0), false, { windows: 2, paneDead: false })] });
        const { reaper, log } = makeReaper({ exec });

        expect(await reaper.reap()).toBe(0);
        expect(killCommands(exec)).toEqual([]);
        expect(log.info).not.toHaveBeenCalled();
    });

    it('reaps every dead detached owned session in one pass, logged as one count line', async () => {
        const exec = fakeExec({ list: [row(ours(0), false, { paneDead: true }), row(ours(3), false, { paneDead: true })] });
        const { reaper, log } = makeReaper({ exec });

        expect(await reaper.reap()).toBe(2);
        expect(killCommands(exec)).toEqual([buildKillSession(ours(0)), buildKillSession(ours(3))]);
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('2'));
    });

    it('reaps nothing and logs nothing when the server has no sessions', async () => {
        const exec = fakeExec({ list: ['no server running on /tmp/tmux-1000/default'] });
        const { reaper, log } = makeReaper({ exec });

        expect(await reaper.reap()).toBe(0);
        expect(killCommands(exec)).toEqual([]);
        expect(log.info).not.toHaveBeenCalled();
    });
});

describe('reap — startup grace (injected clock)', () => {
    it('spares a young dead session younger than the grace, reaps it once past the grace', async () => {
        const young = fakeExec({ list: [row(ours(0), false, { paneDead: true, created: NOW })] });
        const youngReaper = makeReaper({ exec: young, now: NOW });
        expect(await youngReaper.reaper.reap()).toBe(0);
        expect(killCommands(young)).toEqual([]);

        const aged = fakeExec({ list: [row(ours(0), false, { paneDead: true, created: NOW - DEFAULT_REAP_GRACE_SECONDS })] });
        const agedReaper = makeReaper({ exec: aged, now: NOW });
        expect(await agedReaper.reaper.reap()).toBe(1);
        expect(killCommands(aged)).toEqual([buildKillSession(ours(0))]);
    });
});

describe('reap — failure handling (never breaks the connect)', () => {
    it('logs and returns 0 when list-sessions fails — no throw, no kills', async () => {
        const exec = fakeExec({ throwOnList: true });
        const { reaper, log } = makeReaper({ exec });

        await expect(reaper.reap()).resolves.toBe(0);
        expect(killCommands(exec)).toEqual([]);
        expect(log.trace).toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
    });

    it('keeps reaping the rest when one kill fails, and never throws (no kill storm)', async () => {
        const exec = fakeExec({
            list: [row(ours(0), false, { paneDead: true }), row(ours(1), false, { paneDead: true })],
            throwKillFor: ours(0),
        });
        const { reaper, log } = makeReaper({ exec });

        await expect(reaper.reap()).resolves.toBe(1); // ours(1) still reaped
        expect(killCommands(exec)).toEqual([buildKillSession(ours(0)), buildKillSession(ours(1))]);
        expect(log.trace).toHaveBeenCalled();
    });
});

describe('killWorkspaceSessions — force-kill this workspace (manual escape hatch)', () => {
    const OTHER_WS = '/home/user/other';
    /** An owned session name for a slot in a DIFFERENT workspace on the same host. */
    const otherWs = (slot: number): string => sessionName(HOST, OTHER_WS, slot);

    it('kills EVERY session of this workspace — attached or with live windows too — and nothing else', async () => {
        const exec = fakeExec({
            list: [
                row(ours(0), false),                    // ours, detached        -> kill
                row(ours(1), true, { windows: 2 }),     // ours, attached + live -> kill (force ignores state)
                row(otherWs(0), false),                 // sibling workspace     -> keep (different hash)
                row('main', false, { windows: 3 }),     // foreign               -> keep (not ours)
            ],
        });
        const { reaper, log } = makeReaper({ exec });

        const killed = await reaper.killWorkspaceSessions(HOST, WS);

        expect(killCommands(exec)).toEqual([buildKillSession(ours(0)), buildKillSession(ours(1))]);
        expect(killed).toBe(2);
        expect(log.info).toHaveBeenCalledTimes(1);
    });

    it('kills a young session (no startup grace on an explicit force)', async () => {
        const exec = fakeExec({ list: [row(ours(0), false, { created: NOW })] });
        const { reaper } = makeReaper({ exec, now: NOW });

        expect(await reaper.killWorkspaceSessions(HOST, WS)).toBe(1);
        expect(killCommands(exec)).toEqual([buildKillSession(ours(0))]);
    });

    it('returns 0 and logs nothing when this workspace has no sessions', async () => {
        const exec = fakeExec({ list: [row(otherWs(0), false), row('main', true)] });
        const { reaper, log } = makeReaper({ exec });

        expect(await reaper.killWorkspaceSessions(HOST, WS)).toBe(0);
        expect(killCommands(exec)).toEqual([]);
        expect(log.info).not.toHaveBeenCalled();
    });

    it('returns 0 without throwing when list-sessions fails', async () => {
        const exec = fakeExec({ throwOnList: true });
        const { reaper, log } = makeReaper({ exec });

        await expect(reaper.killWorkspaceSessions(HOST, WS)).resolves.toBe(0);
        expect(killCommands(exec)).toEqual([]);
        expect(log.trace).toHaveBeenCalled();
    });

    it('keeps killing the rest when one kill fails, and never throws', async () => {
        const exec = fakeExec({
            list: [row(ours(0), false), row(ours(1), false)],
            throwKillFor: ours(0),
        });
        const { reaper } = makeReaper({ exec });

        await expect(reaper.killWorkspaceSessions(HOST, WS)).resolves.toBe(1);
        expect(killCommands(exec)).toEqual([buildKillSession(ours(0)), buildKillSession(ours(1))]);
    });
});
