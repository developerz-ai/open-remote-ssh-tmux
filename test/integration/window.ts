import type * as vscode from 'vscode';
import { resolveClientId } from '../../src/tmux/clientIdentity';
import type { HandOffPolicy } from '../../src/tmux/slotState';
import { TmuxTerminalProvider, type OfferTakeOver } from '../../src/tmux/terminalProvider';
import { RIG_TMUX, RigSession } from './rig';

// A VS Code window, as far as the terminal layer can tell: the production
// `TmuxTerminalProvider` over the rig's real exec, a client-local Memento (one per
// "machine"), and an `openTerminal` that does what VS Code's remote pty host does with
// the returned options — exec `shellPath shellArgs` on a pty that outlives the window
// (`RigSession#spawnHeldClient`). Used by the multi-client hand-off specs.

/** `context.workspaceState` stand-in. Keep one per simulated machine and hand the same
 * instance to that machine's next window: it is what survives a reload/reconnect. */
export class MachineState implements vscode.Memento {
    private readonly store = new Map<string, unknown>();

    keys(): readonly string[] {
        return [...this.store.keys()];
    }

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.store.has(key) ? this.store.get(key) as T : defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.store.delete(key);
        } else {
            this.store.set(key, value);
        }
    }
}

/** Per-window knobs for the hand-off specs. */
export interface RigWindowOptions {
    readonly handOff?: HandOffPolicy;
    /** The user's answer to the take-over offer. Default: never accepted. */
    readonly offerTakeOver?: OfferTakeOver;
    /** Staleness threshold, so a spec need not wait the production two minutes. */
    readonly staleClientSeconds?: number;
}

/** What a simulated window opened: the held client's holder pid per tmux session. */
export interface OpenedTerminal {
    readonly session: string;
    readonly holderPid: number;
}

/** One window of one machine against the rig. */
export class RigWindow {
    readonly provider: TmuxTerminalProvider;
    readonly opened: OpenedTerminal[] = [];
    readonly log: string[] = [];
    private readonly spawns: Promise<void>[] = [];

    constructor(
        private readonly rig: RigSession,
        private readonly state: MachineState,
        ctx: { hostKey: string; workspaceKey: string; cwd: string },
        options: RigWindowOptions = {},
    ) {
        this.provider = new TmuxTerminalProvider({
            ctx,
            exec: rig.exec,
            state,
            openTerminal: options => this.spawns.push(this.launch(options)),
            log: { info: message => this.log.push(message), trace: message => this.log.push(message) },
            tmuxPath: RIG_TMUX,
            reviveGraceMs: 0,
            // One id per simulated machine: the nonce lives in the machine's state, exactly
            // as production keeps it in workspaceState.
            clientId: resolveClientId('rig-machine', state),
            ...options,
        });
    }

    /** Connect/reconnect reconciliation, then wait until every terminal it opened runs. */
    async connect(): Promise<void> {
        await this.provider.initialize({ awaitRevive: false });
        await Promise.all(this.spawns);
    }

    /** This window's client id — what its attaches write as the session owner tag. */
    get clientId(): string {
        return resolveClientId('rig-machine', this.state);
    }

    /** Wait until every terminal the provider opened on its own (offer accepted) runs. */
    async settled(): Promise<void> {
        await Promise.all(this.spawns);
    }

    /** The user pressing "New Terminal": ask the provider, then launch what it returned. */
    async newTerminal(): Promise<OpenedTerminal> {
        const profile = await this.provider.provideTerminalProfile() as unknown as { options: vscode.TerminalOptions };
        await this.launch(profile.options);
        return this.opened[this.opened.length - 1];
    }

    private async launch(options: vscode.TerminalOptions): Promise<void> {
        const args = typeof options.shellArgs === 'string' ? [options.shellArgs] : options.shellArgs ?? [];
        const session = args[args.indexOf('-s') + 1];
        const holderPid = await this.rig.spawnHeldClient(options.shellPath ?? RIG_TMUX, args);
        this.opened.push({ session, holderPid });
    }
}
