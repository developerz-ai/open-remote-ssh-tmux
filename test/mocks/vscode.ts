// Minimal stand-in for the `vscode` module, aliased in via `vitest.config.ts`.
// The real module only exists inside the extension host, so unit tests that pull
// in production code (which does `import * as vscode from 'vscode'`) need this
// stub. Keep it small: add surface here only when a module under test needs it.

export const version = '1.70.2';

export const env: { appRoot: string; machineId: string; remoteName?: string; remoteAuthority?: string } = {
    appRoot: '/vscode/appRoot',
    machineId: 'test-machine-id',
    // Undefined models a local window; a test sets these to model a remote one.
    remoteName: undefined,
    remoteAuthority: undefined,
};

/**
 * Values a test can seed to simulate user/workspace configuration. Keys are the
 * fully-qualified setting id (e.g. `remote.SSH.serverValidation`). Anything not
 * present resolves to the caller-provided default, mirroring real `vscode`.
 */
export const configOverrides = new Map<string, unknown>();

/**
 * Per-setting `inspect()` scope values a test can seed to model *where* a user's choice
 * lives — User/Global (`globalValue`; in a remote window this also reflects the remote
 * user settings), Workspace, or folder. Keyed by fully-qualified id; an unseeded id
 * inspects as "nothing set at any scope".
 */
export const inspectOverrides = new Map<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>();

/**
 * Every `config.update(...)` call, recorded as `(id, value, target)` so a test can assert
 * what — and whether — the extension wrote, and at which scope.
 */
export const updateCalls: { id: string; value: unknown; target: unknown }[] = [];

/** What the next `config.update(...)` calls settle with. Unset: they resolve at once. A test
 * sets `result` to hold a write open (the remote settings file not written yet) or fail it. */
export const updateControl: { result?: () => Promise<void> } = {};

/** Mirror of `vscode.ConfigurationTarget` (values match the real enum) — the default-profile
 * write targets `Workspace`; exposed so a test can assert the scope. */
export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

class MockWorkspaceConfiguration {
    public constructor(private readonly section: string | undefined) {}

    public get<T>(key: string, defaultValue?: T): T | undefined {
        const id = this.section ? `${this.section}.${key}` : key;
        return configOverrides.has(id) ? (configOverrides.get(id) as T) : defaultValue;
    }

    public inspect<T>(key: string): { key: string; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } {
        const id = this.section ? `${this.section}.${key}` : key;
        const seeded = inspectOverrides.get(id) ?? {};
        return {
            key: id,
            globalValue: seeded.globalValue as T | undefined,
            workspaceValue: seeded.workspaceValue as T | undefined,
            workspaceFolderValue: seeded.workspaceFolderValue as T | undefined,
        };
    }

    public update(key: string, value: unknown, target?: unknown): Promise<void> {
        const id = this.section ? `${this.section}.${key}` : key;
        updateCalls.push({ id, value, target });
        return updateControl.result ? updateControl.result() : Promise.resolve();
    }
}

/**
 * The subset of `vscode.Uri` the remote-location reader inspects (scheme /
 * authority / path only). A test seeds these onto `workspace` to model the open
 * workspace; production derives the remote host + path from them.
 */
export interface UriLike {
    scheme: string;
    authority: string;
    path: string;
}

/** `vscode.Uri.from` — the components are all a test inspects, so they are the "Uri". */
export const Uri = {
    from(components: UriLike): UriLike {
        return { ...components };
    },
};

export const workspace: {
    workspaceFile?: UriLike;
    workspaceFolders?: { uri: UriLike }[];
    getConfiguration(section?: string): MockWorkspaceConfiguration;
} = {
    // Undefined models "no workspace open"; a test overwrites these per case.
    // (`workspaceFolders` is `undefined` with nothing open but an EMPTY ARRAY for
    // an empty-folder workspace — the case that must not crash `activate()`.)
    workspaceFile: undefined,
    workspaceFolders: undefined,
    getConfiguration(section?: string): MockWorkspaceConfiguration {
        return new MockWorkspaceConfiguration(section);
    },
};

class MockOutputChannel {
    public readonly name: string;
    public readonly lines: string[] = [];

    public constructor(channelName: string) {
        this.name = channelName;
    }

    public append(value: string): void {
        this.lines.push(value);
    }

    public appendLine(value: string): void {
        this.lines.push(value);
    }

    public clear(): void {
        this.lines.length = 0;
    }

    public show(): void {
        // no-op: nothing to reveal in a headless test.
    }

    public hide(): void {
        // no-op.
    }

    public dispose(): void {
        // no-op.
    }
}

/**
 * Seedable return value for `window.showWarningMessage` — a test sets this to the
 * button label it wants the simulated user to click (or leaves it `undefined` to
 * model dismiss/cancel). Mirrors the real API returning the chosen item.
 */
export const messageResponses: { warning: unknown; information: unknown } = { warning: undefined, information: undefined };

/** Messages surfaced via the `window.show*Message` APIs, recorded (message + items)
 * per call so a test can assert what — and whether — a dialog was shown. */
export const shownMessages: { warning: unknown[][]; information: unknown[][]; error: unknown[][] } = { warning: [], information: [], error: [] };

/** Seedable return value for `window.showInputBox` — a test sets this to the string
 * the simulated user typed (or leaves it `undefined` to model dismiss/Escape). */
export const inputBoxResponses: { value: string | undefined } = { value: undefined };

/** Every `window.showInputBox(options)` call, recorded so a test can exercise the
 * options' own `validateInput`, matching how the real UI would reject bad input
 * before the value is even returned to the caller. */
export const shownInputBoxes: { title?: string; validateInput?: (value: string) => string | undefined | null }[] = [];

/** Mirror of `vscode.QuickPickItemKind` (values match the real enum). */
export enum QuickPickItemKind {
    Separator = -1,
    Default = 0,
}

type Listener<T> = (value: T) => void;

/** A tiny event: `fire` calls every listener; the returned disposable unsubscribes. */
class MockEvent<T> {
    private readonly listeners = new Set<Listener<T>>();

    public readonly event = (listener: Listener<T>): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => void this.listeners.delete(listener) };
    };

    public fire(value: T): void {
        for (const listener of [...this.listeners]) {
            listener(value);
        }
    }
}

/**
 * Stand-in for `vscode.QuickPick`: holds the properties production sets, and lets a test
 * play the user — `type(value)` (fires `onDidChangeValue`), `accept(item?)` (selects, then
 * fires `onDidAccept`), `hide()` (Escape).
 */
export class MockQuickPick<T> {
    public title: string | undefined;
    public placeholder: string | undefined;
    public matchOnDescription = false;
    public items: readonly T[] = [];
    public selectedItems: readonly T[] = [];
    public activeItems: readonly T[] = [];
    public value = '';
    public shown = false;
    public disposed = false;

    private readonly changeValue = new MockEvent<string>();
    private readonly didAccept = new MockEvent<void>();
    private readonly didHide = new MockEvent<void>();
    public readonly onDidChangeValue = this.changeValue.event;
    public readonly onDidAccept = this.didAccept.event;
    public readonly onDidHide = this.didHide.event;

    public show(): void {
        this.shown = true;
    }

    public hide(): void {
        if (this.shown) {
            this.shown = false;
            this.didHide.fire();
        }
    }

    public dispose(): void {
        this.disposed = true;
    }

    public type(value: string): void {
        this.value = value;
        this.changeValue.fire(value);
    }

    public accept(item?: T): void {
        this.selectedItems = item ? [item] : [];
        this.didAccept.fire();
    }
}

/** Every quick pick production created, newest last — a test drives `.at(-1)`. */
export const createdQuickPicks: MockQuickPick<unknown>[] = [];

export const window = {
    createQuickPick<T>(): MockQuickPick<T> {
        const pick = new MockQuickPick<T>();
        createdQuickPicks.push(pick as MockQuickPick<unknown>);
        return pick;
    },
    createOutputChannel(channelName: string): MockOutputChannel {
        return new MockOutputChannel(channelName);
    },
    showInputBox(options?: { title?: string; validateInput?: (value: string) => string | undefined | null }): Promise<string | undefined> {
        shownInputBoxes.push(options ?? {});
        return Promise.resolve(inputBoxResponses.value);
    },
    showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownMessages.warning.push([message, ...items]);
        return Promise.resolve(messageResponses.warning);
    },
    showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownMessages.information.push([message, ...items]);
        return Promise.resolve(messageResponses.information);
    },
    showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownMessages.error.push([message, ...items]);
        return Promise.resolve(undefined);
    },
};

/** Every `commands.executeCommand(...)` call, recorded as `(command, args)` so a
 * test can assert what a handler asked VS Code to do (e.g. open a new window). */
export const executedCommands: { command: string; args: unknown[] }[] = [];

export const commands = {
    executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        executedCommands.push({ command, args });
        return Promise.resolve(undefined);
    },
};

/**
 * Stand-in for `vscode.TerminalProfile` — a value the terminal provider constructs
 * (`new vscode.TerminalProfile(options)`), so it must exist at runtime. It only
 * needs to carry the options through for assertions; the real class does the same.
 */
export class TerminalProfile {
    public constructor(public readonly options: unknown) {}
}
