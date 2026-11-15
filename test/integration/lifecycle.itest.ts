import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildAttachOrCreateArgv, buildClaimSessionCommand, isDuplicateSession, sessionName } from '../../src/tmux/tmuxSession';
import { describeRig, RIG_TMUX, RigSession, WORKERS } from './rig';
import { MachineState, RigWindow } from './window';

// Session lifecycle against real tmux (slice 05): adopting sessions named under the
// pre-05 (alias-keyed) identity into the canonical one, two machines opening a terminal at
// the same moment, and what tmux itself does with SSH_AUTH_SOCK across re-attaches.

const LEGACY = { hostKey: 'myvps', workspaceKey: '/home/w7/' };
const CANONICAL = { hostKey: 'w7@203.0.113.7:22', workspaceKey: '/home/w7' };
const CTX = { ...CANONICAL, cwd: '/home/w7/', legacy: LEGACY };
const legacy = (slot: number): string => sessionName(LEGACY.hostKey, LEGACY.workspaceKey, slot);
const canonical = (slot: number): string => sessionName(CANONICAL.hostKey, CANONICAL.workspaceKey, slot);

describeRig('session lifecycle (real tmux, 05)', target => {
    let rig: RigSession;
    let other: RigSession;

    beforeAll(async () => {
        rig = await RigSession.open(target, WORKERS.lifecycle);
    });

    afterAll(async () => {
        await rig.resetTmux();
        await rig.close();
    });

    beforeEach(async () => {
        await rig.resetTmux();
        other = await RigSession.open(target, WORKERS.lifecycle);
    });

    afterEach(async () => {
        await other.close();
    });

    /** The pid of the process in `name`'s pane — what must survive an adoption. */
    async function panePid(name: string): Promise<string> {
        return (await rig.tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_pid}')).stdout.trim();
    }

    it('(05 c) an upgrade adopts the legacy-named session: renamed in place, process untouched, attached', async () => {
        expect((await rig.tmux('new-session', '-d', '-s', legacy(0), '-c', '/home/w7')).code).toBe(0);
        const pid = await panePid(legacy(0));
        const machine = new MachineState();
        await machine.update('tmux.slotSessions.v1', { '0': legacy(0) }); // what the old version persisted

        const window = new RigWindow(rig, machine, CTX);
        await window.connect();

        expect(await rig.sessionNames()).toEqual([canonical(0)]);
        expect(await panePid(canonical(0))).toBe(pid);
        expect(window.opened.map(t => t.session)).toEqual([canonical(0)]);
        await rig.waitUntil('re-attached', () => rig.heldClientAttached(window.opened[0].holderPid, canonical(0)));
        expect(machine.get('tmux.slotSessions.v1')).toEqual({ '0': canonical(0) });
    });

    it('(05 c) a canonical slot already in use pushes the legacy session to the next slot — nothing is lost', async () => {
        for (const name of [canonical(0), legacy(0)]) {
            expect((await rig.tmux('new-session', '-d', '-s', name)).code).toBe(0);
        }
        const pid = await panePid(legacy(0));

        const window = new RigWindow(rig, new MachineState(), CTX);
        await window.connect();

        expect((await rig.sessionNames()).sort()).toEqual([canonical(0), canonical(1)].sort());
        expect(await panePid(canonical(1))).toBe(pid);
        expect(window.opened.map(t => t.session).sort()).toEqual([canonical(0), canonical(1)].sort());
    });

    it('(05 c) leaves a legacy session another machine is using alone, adopts it once released', async () => {
        const otherMachine = new RigWindow(other, new MachineState(), { ...LEGACY, cwd: '/home/w7' });
        const held = await otherMachine.newTerminal(); // the not-yet-upgraded laptop, live
        expect(held.session).toBe(legacy(0));
        await rig.waitUntil('laptop attached', () => rig.heldClientAttached(held.holderPid, legacy(0)));

        const window = new RigWindow(rig, new MachineState(), CTX);
        await window.connect();
        expect(await rig.sessionNames()).toEqual([legacy(0)]);
        expect(await rig.heldClientAttached(held.holderPid, legacy(0))).toBe(true);

        await other.closeHeldClient(held.holderPid);
        await rig.waitUntil('laptop detached', async () => (await rig.clientCount(legacy(0))) === 0);
        await window.connect(); // the next reconnect
        expect(await rig.sessionNames()).toEqual([canonical(0)]);
    });

    // (05 l) Two machines pressing "New Terminal" at the same instant. Each listed the
    // sessions, saw slot 0 free, and returned `new-session -A -s <slot 0>`: the second spawn
    // attached to the first one's brand-new session — one shell, two machines, mirrored
    // (reproduced here on every version before the fix). The slot is now claimed on the
    // remote (`new-session -d`) before it is handed out, and the loser moves on.
    it('(05 l) two machines opening a terminal at once land on different sessions', async () => {
        const a = new RigWindow(rig, new MachineState(), CTX);
        const b = new RigWindow(other, new MachineState(), CTX);
        await Promise.all([a.connect(), b.connect()]);

        const [ta, tb] = await Promise.all([a.newTerminal(), b.newTerminal()]);

        expect(ta.session).not.toBe(tb.session);
        expect([ta.session, tb.session].sort()).toEqual([canonical(0), canonical(1)]);
        await rig.waitUntil('both attached', async () =>
            await rig.heldClientAttached(ta.holderPid, ta.session) && await rig.heldClientAttached(tb.holderPid, tb.session));
        expect(await rig.clientCount(ta.session)).toBe(1);
        expect(await rig.clientCount(tb.session)).toBe(1);
    });

    // A refused claim aborts its chain mid-way. Below 3.7 that is after the chain borrowed
    // the GLOBAL history-limit, so the claim command restores it on failure — the user's
    // value must be exactly what it was, on every version.
    it('(05 l) a refused claim leaves the user\'s global history-limit untouched', async () => {
        expect((await rig.tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        expect((await rig.tmux('set-option', '-g', 'history-limit', '1234')).code).toBe(0);
        expect((await rig.tmux('new-session', '-d', '-s', canonical(0))).code).toBe(0);

        const claim = await rig.exec(buildClaimSessionCommand(canonical(0), '/home/w7', { tmuxPath: RIG_TMUX, tmuxVersion: target.version }));

        expect(claim.code).not.toBe(0);
        expect(isDuplicateSession(claim.stderr + claim.stdout)).toBe(true);
        expect((await rig.tmux('show-options', '-gv', 'history-limit')).stdout.trim()).toBe('1234');
    });

    // (05 j) tmux's default `update-environment` copies SSH_AUTH_SOCK from each attaching
    // client into the SESSION environment, so a new pane after a re-attach sees the fresh
    // socket — but the shell already running keeps the value it started with. Our sessions
    // have exactly one pane, so the running shell is what the user has.
    it('(05 j) a re-attach refreshes SSH_AUTH_SOCK for new panes only', async () => {
        const name = canonical(0);
        const first = await rig.spawnHeldClient('env', ['SSH_AUTH_SOCK=/tmp/agent-old', RIG_TMUX, ...buildAttachOrCreateArgv(name, '/home/w7')]);
        await rig.waitUntil('first attach', () => rig.heldClientAttached(first, name));
        const shellPid = (await rig.tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_pid}')).stdout.trim();
        await rig.closeHeldClient(first);
        await rig.waitUntil('detached', async () => (await rig.clientCount(name)) === 0);

        const second = await rig.spawnHeldClient('env', ['SSH_AUTH_SOCK=/tmp/agent-new', RIG_TMUX, ...buildAttachOrCreateArgv(name, '/home/w7')]);
        await rig.waitUntil('second attach', () => rig.heldClientAttached(second, name));

        const sessionEnv = (await rig.tmux('show-environment', '-t', `=${name}`, 'SSH_AUTH_SOCK')).stdout.trim();
        const runningShell = await rig.ok(`tr '\\0' '\\n' < /proc/${shellPid}/environ | grep '^SSH_AUTH_SOCK=' || true`);
        expect(sessionEnv).toBe('SSH_AUTH_SOCK=/tmp/agent-new');
        expect(runningShell).toBe('SSH_AUTH_SOCK=/tmp/agent-old');
    });
});
