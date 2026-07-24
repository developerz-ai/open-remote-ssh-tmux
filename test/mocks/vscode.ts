// Minimal stand-in for the `vscode` module, aliased in via `vitest.config.ts`.
// The real module only exists inside the extension host, so unit tests that pull
// in production code (which does `import * as vscode from 'vscode'`) need this
// stub. Keep it small: add surface here only when a module under test needs it.

export const version = '1.70.2';

export const env = {
    appRoot: '/vscode/appRoot',
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
        return Promise.resolve();
    }
}

export const workspace = {
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
export const messageResponses: { warning: unknown } = { warning: undefined };

/** Messages surfaced via the `window.show*Message` APIs, recorded (message + items)
 * per call so a test can assert what — and whether — a dialog was shown. */
export const shownMessages: { warning: unknown[][]; information: unknown[][]; error: unknown[][] } = { warning: [], information: [], error: [] };

export const window = {
    createOutputChannel(channelName: string): MockOutputChannel {
        return new MockOutputChannel(channelName);
    },
    showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownMessages.warning.push([message, ...items]);
        return Promise.resolve(messageResponses.warning);
    },
    showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownMessages.information.push([message, ...items]);
        return Promise.resolve(undefined);
    },
    showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownMessages.error.push([message, ...items]);
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
