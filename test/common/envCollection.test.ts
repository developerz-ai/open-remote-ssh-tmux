import { describe, expect, it, vi } from 'vitest';
import { applyEnvCollection, prepareEnvCollection, type EnvCollectionSink } from '../../src/common/envCollection';

// Why this exists: VS Code marks every already-open terminal "stale" the moment an
// extension's EnvironmentVariableCollection changes, and offers to relaunch it. Upstream
// open-remote-ssh re-`replace()`s SSH_AUTH_SOCK on *every* resolve, which is harmless
// there because its terminals die with the connection anyway — but this fork's terminals
// are tmux-backed and outlive reconnects, so a reconnect that rewrites an unchanged value
// hangs a "wants to relaunch the terminal to contribute to its environment" warning on
// terminals that have nothing wrong with them, and relaunching would be the one action
// that throws away the persistence the fork exists to provide.

function fakeSink() {
    const values = new Map<string, string>();
    const sink = {
        persistent: true,
        replace: vi.fn((key: string, value: string) => { values.set(key, value); }),
        delete: vi.fn((key: string) => { values.delete(key); }),
    };
    return { sink: sink as EnvCollectionSink & typeof sink, values };
}

describe('applyEnvCollection', () => {
    it('writes each variable on the first application', () => {
        const { sink, values } = fakeSink();
        const applied = new Map<string, string>();

        expect(applyEnvCollection(sink, applied, { SSH_AUTH_SOCK: '/tmp/ssh-a/agent.1' })).toEqual(['SSH_AUTH_SOCK']);
        expect(values.get('SSH_AUTH_SOCK')).toBe('/tmp/ssh-a/agent.1');
    });

    // THE FIX. A reconnect resolves the same values; rewriting them is what raises the
    // relaunch warning on terminals whose environment did not actually change.
    it('writes nothing when a later application resolves identical values', () => {
        const { sink } = fakeSink();
        const applied = new Map<string, string>();
        const wanted = { SSH_AUTH_SOCK: '/tmp/ssh-a/agent.1' };

        applyEnvCollection(sink, applied, wanted);
        sink.replace.mockClear();

        expect(applyEnvCollection(sink, applied, wanted)).toEqual([]);
        expect(sink.replace).not.toHaveBeenCalled();
    });

    it('writes only the variables whose value genuinely changed', () => {
        const { sink } = fakeSink();
        const applied = new Map<string, string>();
        applyEnvCollection(sink, applied, { A: '1', B: '2' });
        sink.replace.mockClear();

        expect(applyEnvCollection(sink, applied, { A: '1', B: '3' })).toEqual(['B']);
        expect(sink.replace).toHaveBeenCalledTimes(1);
        expect(sink.replace).toHaveBeenCalledWith('B', '3');
    });

    // A variable we previously contributed that this resolve no longer resolves has to be
    // withdrawn, not left behind pointing at a socket from a dead connection.
    it('deletes a variable that is no longer wanted', () => {
        const { sink, values } = fakeSink();
        const applied = new Map<string, string>();
        applyEnvCollection(sink, applied, { SSH_AUTH_SOCK: '/tmp/ssh-a/agent.1' });

        expect(applyEnvCollection(sink, applied, {})).toEqual(['SSH_AUTH_SOCK']);
        expect(sink.delete).toHaveBeenCalledWith('SSH_AUTH_SOCK');
        expect(values.has('SSH_AUTH_SOCK')).toBe(false);
    });

    // `null`/empty is how the resolver models "the remote did not report one" — the same
    // as absent, and specifically not a reason to contribute an empty string.
    it.each([[null], ['']])('treats %o as not wanted', (value) => {
        const { sink } = fakeSink();
        const applied = new Map<string, string>();

        expect(applyEnvCollection(sink, applied, { SSH_AUTH_SOCK: value })).toEqual([]);
        expect(sink.replace).not.toHaveBeenCalled();
    });

    it('does not re-delete a variable already withdrawn', () => {
        const { sink } = fakeSink();
        const applied = new Map<string, string>();
        applyEnvCollection(sink, applied, { A: '1' });
        applyEnvCollection(sink, applied, {});
        sink.delete.mockClear();

        expect(applyEnvCollection(sink, applied, {})).toEqual([]);
        expect(sink.delete).not.toHaveBeenCalled();
    });

    // `persistent = true` means VS Code restores the collection into terminals of the next
    // window before this extension has even activated, so a stale SSH_AUTH_SOCK from the
    // last session would be applied and then corrected — a change after creation, i.e. the
    // warning again. Assigning it is itself a mutation, so it happens only while it differs.
    it('clears persistence once, and not again on later applications', () => {
        const { sink } = fakeSink();
        const applied = new Map<string, string>();

        applyEnvCollection(sink, applied, { A: '1' });
        expect(sink.persistent).toBe(false);

        let assignments = 0;
        Object.defineProperty(sink, 'persistent', {
            get: () => false,
            set: () => { assignments++; },
        });
        applyEnvCollection(sink, applied, { A: '1' });
        expect(assignments).toBe(0);
    });
});

describe('prepareEnvCollection', () => {
    // Timing is the whole point. Every mutation of an environment contribution invalidates
    // already-open terminals, and VS Code only relaunches them silently when it judges that
    // safe — a tmux terminal, with a live process in it, never is. Settling `persistent` at
    // activation means the one unavoidable mutation lands when the window has no terminals
    // to invalidate, instead of several seconds later when the SSH connect finishes.
    it('clears persistence so nothing is restored into a later window', () => {
        const { sink } = fakeSink();

        prepareEnvCollection(sink);

        expect(sink.persistent).toBe(false);
    });

    it('contributes no variables of its own', () => {
        const { sink } = fakeSink();

        prepareEnvCollection(sink);

        expect(sink.replace).not.toHaveBeenCalled();
        expect(sink.delete).not.toHaveBeenCalled();
    });

    // Having run at activation, the later resolve must not assign `persistent` again — that
    // second assignment would be exactly the post-terminal mutation being avoided.
    it('leaves nothing for the resolve-time apply to mutate', () => {
        const { sink } = fakeSink();
        prepareEnvCollection(sink);

        let assignments = 0;
        Object.defineProperty(sink, 'persistent', { get: () => false, set: () => { assignments++; } });
        applyEnvCollection(sink, new Map(), {});

        expect(assignments).toBe(0);
    });
});
