import * as vscode from 'vscode';

// Sole owner of the extension's one `contributes.terminal.profiles` id ("tmux").
//
// VS Code allows exactly ONE provider per profile id and *throws* on a second
// `registerTerminalProfileProvider` for an occupied id — it does not override. The
// v1.0.0 field failure was exactly that: `activate()` installed the plain-shell
// `FallbackTerminalProvider` on the id, then `wireTmuxTerminalLayer` registered the
// real `TmuxTerminalProvider` on the same id, threw `Terminal profile provider
// "tmux" already registered`, and the whole tmux layer was skipped on every connect
// — "Persistent Shell" quietly opened a plain bash terminal and no tmux server was
// ever started on the remote. Silent because the throw was swallowed by the wiring
// try/catch and the id *did* still resolve (to the fallback).
//
// Making the id one object's responsibility (S in SOLID) removes the class of bug:
// callers say which provider should own it and the swap — dispose-then-register, in
// that order — is centralised here rather than duplicated at two call sites that
// each assumed the other wasn't there.
//
// Dependency-inverted (D): the registrar is injected, so the swap is unit-tested
// against a fake with VS Code's real one-provider-per-id rule, no live editor.

/** The `vscode.window.registerTerminalProfileProvider` capability this module needs. */
export type RegisterProfileProvider = (
    id: string,
    provider: vscode.TerminalProfileProvider
) => vscode.Disposable;

/**
 * Holds the single live registration for one terminal-profile id and swaps the
 * provider behind it. Push to `context.subscriptions` — {@link dispose} releases the
 * id so a deactivate/reload doesn't leak it.
 */
export class TerminalProfileRegistration implements vscode.Disposable {
    private readonly id: string;
    private readonly register: RegisterProfileProvider;
    /** The live registration, or `undefined` when the id is currently unowned. */
    private current: vscode.Disposable | undefined;

    /**
     * @param id contributed profile id to own (must match `contributes.terminal.profiles`).
     * @param register registrar; defaults to the real VS Code one.
     */
    constructor(id: string, register: RegisterProfileProvider = (profileId, provider) => vscode.window.registerTerminalProfileProvider(profileId, provider)) {
        this.id = id;
        this.register = register;
    }

    /**
     * Make `provider` the owner of the id, releasing whichever provider held it before.
     * Dispose-before-register is the whole point: registering first would hit VS Code's
     * "already registered" throw. `current` is cleared *before* the register call so a
     * throwing registrar leaves no stale disposable behind (a later `use`/`dispose`
     * stays safe).
     */
    use(provider: vscode.TerminalProfileProvider): void {
        const previous = this.current;
        this.current = undefined;
        previous?.dispose();
        this.current = this.register(this.id, provider);
    }

    /** Release the id. Idempotent — safe as a `context.subscriptions` entry. */
    dispose(): void {
        const previous = this.current;
        this.current = undefined;
        previous?.dispose();
    }
}
