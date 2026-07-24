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

class MockWorkspaceConfiguration {
    public constructor(private readonly section: string | undefined) {}

    public get<T>(key: string, defaultValue?: T): T | undefined {
        const id = this.section ? `${this.section}.${key}` : key;
        return configOverrides.has(id) ? (configOverrides.get(id) as T) : defaultValue;
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

export const window = {
    createOutputChannel(channelName: string): MockOutputChannel {
        return new MockOutputChannel(channelName);
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
