import type * as vscode from 'vscode';
import { TmuxTerminalProvider } from '../../src/tmux/terminalProvider';
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
        state: MachineState,
        ctx: { hostKey: string; workspaceKey: string; cwd: string },
    ) {
        this.provider = new TmuxTerminalProvider({
            ctx,
            exec: rig.exec,
            state,
            openTerminal: options => this.spawns.push(this.launch(options)),
            log: { info: message => this.log.push(message), trace: message => this.log.push(message) },
            tmuxPath: RIG_TMUX,
            reviveGraceMs: 0,
        });
    }

    /** Connect/reconnect reconciliation, then wait until every terminal it opened runs. */
    async connect(): Promise<void> {
        await this.provider.initialize({ awaitRevive: false });
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
