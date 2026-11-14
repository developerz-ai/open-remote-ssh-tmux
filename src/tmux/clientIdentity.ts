import { createHash, randomBytes } from 'crypto';
import type * as vscode from 'vscode';

// Who is attached: the id each window writes into its tmux sessions (`@orst_owner`, see
// `buildAttachOrCreateArgv`), so another machine reading `list-sessions` can tell its own
// stale client from someone else's live one (`slotState.ts`).
//
// Two parts, because neither alone is enough:
//   * a machine part — the first 8 hex of sha1(`vscode.env.machineId`). Hashed because the
//     tag is readable by anyone on the remote and machineId is a stable device identifier;
//   * a window part — a random nonce kept in `workspaceState`. Two windows of one machine
//     can hold separate workspaceStates over the same first folder (a folder window and a
//     multi-root workspace), i.e. separate slot mappings: to each other they are as foreign
//     as two machines. It also keeps ids apart on builds where machineId is a constant.

/** workspaceState key of this window's nonce. Versioned like the slot mapping's key. */
export const CLIENT_NONCE_STATE_KEY = 'tmux.clientNonce.v1';

const NONCE_RE = /^[0-9a-f]{8}$/;
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{8}$/;

/** The owner tag for (machine, window nonce). Pure. */
export function clientId(machineId: string, nonce: string): string {
    const machine = createHash('sha1').update(machineId).digest('hex').slice(0, 8);
    return `${machine}-${nonce}`;
}

/** Whether `value` has the exact shape {@link clientId} produces. The tag is placed in a tmux
 * argv, so nothing else — no `;`, `#`, whitespace — may ever stand in for one. */
export function isClientId(value: string): boolean {
    return CLIENT_ID_RE.test(value);
}

/**
 * This window's client id: the persisted nonce if there is a well-formed one, else a fresh
 * one that is persisted for the next window. Never fails — a nonce that could not be saved
 * only means the next window looks foreign to this one's sessions, and a foreign-looking
 * session is offered or adopted, never lost.
 */
export function resolveClientId(
    machineId: string,
    state: Pick<vscode.Memento, 'get' | 'update'>,
    mintNonce: () => string = () => randomBytes(4).toString('hex'),
): string {
    const stored = state.get<unknown>(CLIENT_NONCE_STATE_KEY);
    if (typeof stored === 'string' && NONCE_RE.test(stored)) {
        return clientId(machineId, stored);
    }
    const nonce = mintNonce();
    // An unsaved nonce degrades to "foreign next time" (see above), never to a failure —
    // whether the write rejects or throws outright.
    try {
        void Promise.resolve(state.update(CLIENT_NONCE_STATE_KEY, nonce)).catch(() => undefined);
    } catch {
        // tolerated, as above
    }
    return clientId(machineId, nonce);
}
