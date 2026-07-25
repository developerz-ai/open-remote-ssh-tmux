// Idempotent application of an extension's terminal environment contribution.
//
// VS Code treats any change to an `EnvironmentVariableCollection` as invalidating the
// environment of terminals that are already open, and surfaces "…wants to relaunch the
// terminal to contribute to its environment" on each of them. Upstream open-remote-ssh
// re-writes `SSH_AUTH_SOCK` on every resolve, which costs it nothing: its terminals are
// plain remote ptys that do not survive a reconnect anyway.
//
// This fork's terminals are tmux sessions that deliberately DO survive reconnects, so the
// same unconditional write lands on live terminals and asks the user to relaunch them —
// and relaunching is the single action that discards the persistence the fork exists for.
// Worse, it is offered for a value that usually did not change at all: the socket path
// comes from the already-running vscode-server, so a reconnect resolves the same string.
//
// So: diff before writing. Kept as a pure leaf here (`common/*` depends on nothing in the
// project, D in SOLID) with the collection behind {@link EnvCollectionSink}, so the rule is
// unit-testable without a VS Code host and the resolver keeps only the bookkeeping.

/** The slice of `vscode.EnvironmentVariableCollection` this needs (ISP). */
export interface EnvCollectionSink {
    persistent: boolean;
    replace(key: string, value: string): void;
    delete(key: string): void;
}

/**
 * Settle the collection's persistence flag at *activation* time, before any terminal can
 * exist. Every mutation of an environment contribution — including this one — invalidates
 * the environment of terminals already open, and VS Code can only relaunch them silently
 * when it judges that safe; a tmux terminal never is, so the user gets the yellow "wants to
 * relaunch the terminal to contribute to its environment" instead. Doing it here means the
 * one unavoidable mutation happens when there is nothing yet to invalidate, rather than
 * several seconds later when the SSH connect finally completes.
 *
 * It must be false at least once: a persistent collection is restored into the *next*
 * window's terminals before this extension activates, which would apply a socket path from
 * a dead connection.
 */
export function prepareEnvCollection(sink: EnvCollectionSink): void {
    sink.persistent = false;
}

/**
 * Bring `sink` in line with `wanted`, touching only what actually differs.
 *
 * @param sink the collection to mutate.
 * @param applied what this module last wrote — mutated in place, so the caller just keeps
 *   one `Map` alive across resolves. Reading back from `sink` is not an option: the API
 *   exposes no enumeration that distinguishes our own entries from a restored session's.
 * @param wanted the variables this resolve produced. `null`/`''` means "the remote reported
 *   none", which is withdrawal, not a request to contribute an empty string.
 * @returns the keys actually written or deleted — empty when the environment is unchanged,
 *   which is the case that must not disturb a single open terminal.
 */
export function applyEnvCollection(
    sink: EnvCollectionSink,
    applied: Map<string, string>,
    wanted: Readonly<Record<string, string | null | undefined>>,
): string[] {
    // Assigning `persistent` is itself a mutation of the collection, so only do it while it
    // differs — normally {@link prepareEnvCollection} has already settled it at activation,
    // and this is the belt-and-braces path for a sink that somehow arrives persistent.
    if (sink.persistent) {
        sink.persistent = false;
    }

    const changed: string[] = [];
    for (const [key, value] of Object.entries(wanted)) {
        if (!value) {
            continue; // handled by the withdrawal pass below
        }
        if (applied.get(key) !== value) {
            sink.replace(key, value);
            applied.set(key, value);
            changed.push(key);
        }
    }

    for (const key of [...applied.keys()]) {
        const value = wanted[key];
        if (!value) {
            sink.delete(key);
            applied.delete(key);
            changed.push(key);
        }
    }

    return changed;
}
