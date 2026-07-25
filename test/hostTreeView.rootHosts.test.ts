import { describe, expect, it } from 'vitest';
import { rootHostList } from '../src/hostTreeView';

// The "SSH Targets" root list used to be *only* the `Host` entries in the user's SSH
// config, while a remembered folder is keyed by the hostname decoded from the remote
// authority. Those two are not the same set, and when they diverged the folder was
// recorded in globalState with no parent node to render under — reported from the field as
// "I opened a dir and it's not showing in the list" for a host connected to by its FQDN
// rather than by a configured alias.
//
// Kept pure and separate from the tree so the merge rule is unit-testable without mocking
// TreeItem/EventEmitter/ThemeIcon — the view keeps only the presentation.

describe('rootHostList', () => {
    it('lists the configured hosts when nothing is remembered', () => {
        expect(rootHostList(['alpha', 'beta'], [])).toEqual(['alpha', 'beta']);
    });

    it('preserves SSH config order rather than sorting it', () => {
        // The config is a file the user wrote; its order is theirs, and re-sorting it would
        // shuffle a list they scan by position.
        expect(rootHostList(['zulu', 'alpha', 'mike'], [])).toEqual(['zulu', 'alpha', 'mike']);
    });

    // THE FIELD BUG. Connecting by FQDN (authority `ssh-remote+host.example.com`) records
    // the folder under that FQDN, but the tree only had nodes for configured aliases — so
    // the folder existed in storage and was unreachable in the UI.
    it('adds a remembered host that is absent from the SSH config', () => {
        expect(rootHostList(['alpha'], ['host.example.com']))
            .toEqual(['alpha', 'host.example.com']);
    });

    it('does not duplicate a host that is both configured and remembered', () => {
        expect(rootHostList(['alpha', 'beta'], ['beta'])).toEqual(['alpha', 'beta']);
    });

    it('keeps configured hosts first, so the user\'s own list stays on top', () => {
        expect(rootHostList(['beta'], ['aaa.example.com']))
            .toEqual(['beta', 'aaa.example.com']);
    });

    it('sorts the remembered-only hosts, which arrive in arbitrary storage order', () => {
        // globalState key order is an implementation detail; a stable list is not.
        expect(rootHostList([], ['zulu.example.com', 'alpha.example.com']))
            .toEqual(['alpha.example.com', 'zulu.example.com']);
    });

    it('dedupes a config that names the same host twice', () => {
        // `Host a` twice, or `Host a b` plus `Host a` — legal in ssh_config, and two
        // identical root nodes would each carry the same children.
        expect(rootHostList(['alpha', 'alpha'], [])).toEqual(['alpha']);
    });

    it('is empty when there is no config and nothing remembered', () => {
        expect(rootHostList([], [])).toEqual([]);
    });
});
