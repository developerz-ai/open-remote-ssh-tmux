import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeRig, RigSession, sleep, WORKERS } from './rig';
import { MachineState, RigWindow } from './window';

// Hand-off between two machines on the same remote workspace — the fork's headline
// feature — driven through the production `TmuxTerminalProvider` with real tmux clients.
// Both cases are the spec slice 03 (03-handoff-ownership.md) turns green; they fail today:
//  - after B adopts A's session, A's reconnect treats "mapped + attached" as its own stale
//    pty and reclaims with `-A -D`, evicting B's live client (slotState.ts restore-takeover);
//  - a window that dies without detaching leaves its pty — and tmux client — alive on the
//    remote for VS Code's reconnection grace (3 h), and B refuses an attached session.

const CTX = { hostKey: 'rig-host', workspaceKey: '/home/w4', cwd: '/home/w4' };

/** How long a decision gets to play out on the remote before the assertion. */
const SETTLE_MS = 1500;

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

    it.fails('(03) A adopted by B, then A reconnects: B\'s client is still attached', async () => {
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
        await new RigWindow(rigA, machineA, CTX).connect();
        await sleep(SETTLE_MS);

        expect(await rigB.heldClientAttached(terminalB.holderPid, terminalB.session)).toBe(true);
    });

    it.fails('(03) A dies without detaching: B gets the session with no manual detach-client', async () => {
        const windowA = new RigWindow(rigA, new MachineState(), CTX);
        await windowA.connect();
        const terminalA = await windowA.newTerminal();
        await rigB.waitUntil('A attached', () => rigB.heldClientAttached(terminalA.holderPid, terminalA.session));
        // A's VS Code is SIGKILLed / its laptop sleeps: nothing detaches. A's connection
        // goes away, but its tmux client stays on the remote pty (pty-host grace).
        await rigA.close();

        const windowB = new RigWindow(rigB, new MachineState(), CTX);
        await windowB.connect();
        await sleep(SETTLE_MS);

        expect(windowB.opened.map(t => t.session)).toEqual([terminalA.session]);
        expect(await rigB.heldClientAttached(windowB.opened[0].holderPid, terminalA.session)).toBe(true);
    });
});
