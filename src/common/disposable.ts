import * as vscode from 'vscode';

/**
 * Release every disposable in `disposables` (reverse registration order — RAII: a
 * collaborator goes before whatever it was built on) and empty the array.
 *
 * A throwing `dispose()` must not strand the entries behind it. This used to call
 * `dispose()` straight out of the pop loop, so the first failure escaped with the rest
 * of the list still live — leaking exactly the listeners and handles that a rollback or
 * a deactivate was invoked to release, and doing it at the one moment a collaborator is
 * most likely to be in a bad state. Everything is now released first; the first failure
 * encountered is then rethrown, so a broken `dispose()` stays loud instead of becoming a
 * silent leak.
 */
export function disposeAll(disposables: vscode.Disposable[]): void {
    let firstError: unknown;
    let failed = false;
    while (disposables.length) {
        const item = disposables.pop();
        if (!item) {
            continue;
        }
        try {
            item.dispose();
        } catch (err) {
            if (!failed) {
                failed = true;
                firstError = err;
            }
        }
    }
    if (failed) {
        throw firstError;
    }
}

export abstract class Disposable {
    private _isDisposed = false;

    protected _disposables: vscode.Disposable[] = [];

    public dispose(): void {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        disposeAll(this._disposables);
    }

    protected _register<T extends vscode.Disposable>(value: T): T {
        if (this._isDisposed) {
            value.dispose();
        } else {
            this._disposables.push(value);
        }
        return value;
    }

    protected get isDisposed(): boolean {
        return this._isDisposed;
    }
}
