import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildCloseWatchCommand, buildListClientsCommand, buildListSessions, parseListClients, parseListSessions } from '../../src/tmux/tmuxSession';
import { describeRig, PtyClient, RIG_TMUX, RigSession, sleep, WORKERS } from './rig';
import { MachineState, RigWindow } from './window';

// Hand-off between two machines on the same remote workspace — the fork's headline
// feature — driven through the production `TmuxTerminalProvider` with real tmux clients
// (slice 03, 03-handoff-ownership.md). The two (03) specs were the defects:
//  - after B adopts A's session, A's reconnect read "mapped + attached" as its own stale pty
//    and reclaimed with `-A -D`, evicting B's live client;
//  - a window that dies without detaching leaves its pty — and tmux client — alive on the
//    remote for VS Code's reconnection grace (3 h), and B refused an attached session.
// Ownership now comes from the `@orst_owner` tag each attach writes; staleness from
// `#{client_activity}`.

const CTX = { hostKey: 'rig-host', workspaceKey: '/home/w4', cwd: '/home/w4' };

/** How long a decision gets to play out on the remote before the assertion. */
const SETTLE_MS = 1500;

/** Staleness threshold for these specs (production: 120 s). `client_activity` has
 * one-second resolution, hence the wait below is a full second longer. */
const STALE_S = 2;

describeRig('hand-off between machines (real tmux)', target => {
    let rigA: RigSession;
    let rigB: RigSession;

    beforeAll(async () => {
        rigB = await RigSession.open(target, WORKERS.handoff);
    });

    afterAll(async () => {
        await rigB.resetTmux();
        await rigB.close();
    });

    beforeEach(async () => {
        await rigB.resetTmux();
        rigA = await RigSession.open(target, WORKERS.handoff);
    });

    afterEach(async () => {
        await rigA.close();
    });

    it('(03) A adopted by B, then A reconnects: B\'s client is still attached', async () => {
        const machineA = new MachineState();
        const windowA = new RigWindow(rigA, machineA, CTX);
        await windowA.connect();
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
        // A's window closes cleanly: the pty host hangs up its tmux client.
        await rigA.closeHeldClient(terminalA.holderPid);
        await rigB.waitUntil('A detached', async () => (await rigB.clientCount(terminalA.session)) === 0);

        const windowB = new RigWindow(rigB, new MachineState(), CTX);
        await windowB.connect();
        expect(windowB.opened.map(t => t.session)).toEqual([terminalA.session]);
        const terminalB = windowB.opened[0];
        await rigB.waitUntil('B adopted', () => rigB.heldClientAttached(terminalB.holderPid, terminalB.session));

        // A comes back (same machine state: its mapping still lists slot 0).
        const windowA2 = new RigWindow(rigA, machineA, CTX);
        await windowA2.connect();
        await sleep(SETTLE_MS);

        expect(await rigB.heldClientAttached(terminalB.holderPid, terminalB.session)).toBe(true);
        expect(windowA2.opened).toEqual([]);
        // Mapping hygiene: A's entry is forgotten, so the next reconnect does not re-litigate it.
        expect(windowA2.provider.mappedSlots()).toEqual([]);
    });

    it('(03) A dies without detaching: B gets the session with no manual detach-client', async () => {
        const windowA = new RigWindow(rigA, new MachineState(), CTX);
        await windowA.connect();
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
        // A's VS Code is SIGKILLed / its laptop sleeps: nothing detaches. A's connection
        // goes away, but its tmux client stays on the remote pty (pty-host grace).
        await rigA.close();
        await sleep((STALE_S + 1) * 1000);

        const windowB = new RigWindow(rigB, new MachineState(), CTX, { staleClientSeconds: STALE_S });
        await windowB.connect();
        await sleep(SETTLE_MS);

        expect(windowB.opened.map(t => t.session)).toEqual([terminalA.session]);
        expect(await rigB.heldClientAttached(windowB.opened[0].holderPid, terminalA.session)).toBe(true);
        expect(await rigB.heldClientAttached(terminalA.holderPid, terminalA.session)).toBe(false);
    });

    it('a live client of another machine is offered, not taken, and taken once accepted', async () => {
        const windowA = new RigWindow(rigA, new MachineState(), CTX);
        await windowA.connect();
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));

        // Declined: nothing moves.
        const declined = new RigWindow(rigB, new MachineState(), CTX, { offerTakeOver: async () => false });
        await declined.connect();
        await sleep(SETTLE_MS);
        expect(declined.opened).toEqual([]);
        expect(await rigB.heldClientAttached(terminalA.holderPid, terminalA.session)).toBe(true);

        // Accepted: B takes it with -D; A's client is gone, the process inside untouched.
        const panePid = (await rigB.tmux('display-message', '-p', '-t', `=${terminalA.session}:`, '#{pane_pid}')).stdout.trim();
        const accepted = new RigWindow(rigB, new MachineState(), CTX, { offerTakeOver: async () => true });
        await accepted.connect();
        await rigB.waitUntil('B took over', async () => {
            await accepted.settled();
            return accepted.opened.length === 1
                && await rigB.heldClientAttached(accepted.opened[0].holderPid, terminalA.session);
        });
        expect(await rigB.heldClientAttached(terminalA.holderPid, terminalA.session)).toBe(false);
        expect((await rigB.tmux('display-message', '-p', '-t', `=${terminalA.session}:`, '#{pane_pid}')).stdout.trim()).toBe(panePid);
    });

    /** A's close watch on its own connection, as `extension.ts` starts it at wiring. */
    const watchClose = (windowA: RigWindow): void => {
        void rigA.rawExec(buildCloseWatchCommand(windowA.clientId, RIG_TMUX)).catch(() => undefined);
    };
    const closedMarker = async (session: string): Promise<string> =>
        (await rigB.tmux('display-message', '-p', '-t', `=${session}:`, '#{@orst_closed}')).stdout.trim();

    // Bug A (EDH rows 03/22): a closing window cannot detach its client — VS Code kills the
    // extension host first — and the client lives on in VS Code's pty host. The connection
    // dropping is what reaches the remote, and the watch turns it into a marker.
    it('a window whose connection drops is taken over by B at once, at the default threshold', async () => {
        const windowA = new RigWindow(rigA, new MachineState(), CTX);
        await windowA.connect();
        watchClose(windowA);
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
        await sleep(SETTLE_MS); // the watch is waiting on its channel

        await rigA.close();
        await rigB.waitUntil('A\'s sessions marked closed', async () =>
            new RegExp(`^${windowA.clientId}:\\d+$`).test(await closedMarker(terminalA.session)));
        expect(await rigB.heldClientAttached(terminalA.holderPid, terminalA.session)).toBe(true); // pty host keeps it

        const windowB = new RigWindow(rigB, new MachineState(), CTX, { offerTakeOver: async () => false });
        await windowB.connect();
        expect(windowB.opened.map(t => t.session)).toEqual([terminalA.session]);
        await rigB.waitUntil('B took over', async () =>
            await rigB.heldClientAttached(windowB.opened[0].holderPid, terminalA.session)
            && !await rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
    });

    it('a marker never licenses taking a session another machine took over since', async () => {
        const windowA = new RigWindow(rigA, new MachineState(), CTX);
        await windowA.connect();
        watchClose(windowA);
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
        const windowB = new RigWindow(rigB, new MachineState(), CTX, { offerTakeOver: async () => true });
        await windowB.connect();
        await rigB.waitUntil('B took over', async () => {
            await windowB.settled();
            return windowB.opened.length === 1 && await rigB.heldClientAttached(windowB.opened[0].holderPid, terminalA.session);
        });

        await rigA.close(); // A's watch fires now, on a session that is B's
        await sleep(SETTLE_MS);

        const windowC = new RigWindow(rigB, new MachineState(), CTX, { offerTakeOver: async () => false });
        await windowC.connect();
        expect(windowC.opened).toEqual([]);
        expect(await rigB.heldClientAttached(windowB.opened[0].holderPid, terminalA.session)).toBe(true);
    });

    // A reload drops the connection exactly like a close; the reloaded window is the same
    // client and withdraws the marker, so nobody reads its live terminals as abandoned.
    it('the same window coming back withdraws its marker', async () => {
        const machineA = new MachineState();
        const windowA = new RigWindow(rigA, machineA, CTX);
        await windowA.connect();
        watchClose(windowA);
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
        await sleep(SETTLE_MS);
        await rigA.close();
        await rigB.waitUntil('marked', async () => (await closedMarker(terminalA.session)) !== '');

        const reloaded = new RigWindow(rigB, machineA, CTX);
        await reloaded.connect();
        await rigB.waitUntil('marker withdrawn', async () => (await closedMarker(terminalA.session)) === 'none');
    });

    // What the staleness rule measures (recorded in slotState.ts): `client_activity` moves on
    // input through the client, not on output — a pane printing every 200 ms leaves it alone.
    it('client_activity moves on keystrokes, not on output', async () => {
        const name = 'code-000000000000-9';
        expect((await rigB.tmux('new-session', '-d', '-s', name, 'while :; do date; sleep 0.2; done')).code).toBe(0);
        const pty = await PtyClient.open(target, WORKERS.handoff, RIG_TMUX, ['attach-session', '-t', `=${name}`]);
        try {
            await rigB.waitUntil('client attached', async () => (await rigB.clientCount(name)) === 1);
            const activity = async (): Promise<number> =>
                parseListClients((await rigB.exec(buildListClientsCommand(RIG_TMUX))).stdout).clients.find(c => c.session === name)!.activity;
            const before = await activity();
            await sleep(2200); // output keeps flowing the whole time
            expect(await activity()).toBe(before);
            pty.write('x');
            await rigB.waitUntil('activity to move', async () => (await activity()) > before);
        } finally {
            pty.close();
        }
    });

    // The two inputs the decision trusts, read back from this tmux version.
    it('reports the owner tag and client activity this decision relies on', async () => {
        const windowA = new RigWindow(rigA, new MachineState(), CTX);
        await windowA.connect();
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));

        const sessions = parseListSessions((await rigB.exec(buildListSessions(RIG_TMUX))).stdout);
        expect(sessions.find(s => s.name === terminalA.session)?.owner).toBe(windowA.clientId);

        const { now, clients } = parseListClients((await rigB.exec(buildListClientsCommand(RIG_TMUX))).stdout);
        expect(now).toBeGreaterThan(1_700_000_000);
        const activity = clients.find(c => c.session === terminalA.session)?.activity;
        expect(activity).toBeGreaterThan(1_700_000_000);
        expect(now! - activity!).toBeLessThan(60);
    });
});
