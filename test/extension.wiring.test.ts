import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundTerminalsMessage, canonicalTmuxIdentity, CLIPBOARD_PASTE_DEADLINE_MS, CLIPBOARD_SWEEP_DEADLINE_MS, clipboardExec, CLOSE_BACKGROUND_TERMINALS, deactivate, decideDefaultProfile, DETACH_ON_CLOSE_DEADLINE_MS, detachBeforeExit, HAND_OFF_NOT_NOW, HAND_OFF_OFFER_MESSAGE, HAND_OFF_TAKE_OVER, KEEP_BACKGROUND_TERMINALS, LIFETIME_DOCS_URL, LIFETIME_LEARN_MORE, LIFETIME_WARNING_MESSAGE, maybeWarnTerminalLifetime, offerBackgroundCleanup, offerHandOff, decideTmuxWiring, defaultProfileSettingKey, deriveTmuxSessionContext, lazyExec, onceOnly, readTmuxSettings, reconcileDefaultTerminalProfile, resolveSshTarget, TMUX_EXEC_DEADLINE_MS, TMUX_PROFILE_TITLE, TmuxLayerController, tmuxExec, watchTmuxLayerInputs, type TmuxSettings, type TmuxTerminalLayer } from '../src/extension';
import SSHDestination from '../src/ssh/sshDestination';
import type { TmuxSessionContext } from '../src/tmux/terminalProvider';
import { DeadlineError } from '../src/common/deadline';
import { wrapWithExitCode } from '../src/tmux/remoteExec';
import type { RemoteSSHResolver } from '../src/authResolver';
import type Log from '../src/common/logger';
import { ConfigurationTarget, configOverrides, inspectOverrides, messageResponses, shownMessages, TerminalProfile, updateCalls } from './mocks/vscode';
import { FallbackTerminalProvider } from '../src/tmux/fallbackTerminalProvider';

/** A no-op Log — the default-profile reconcile only calls `trace` on the (untaken) error path. */
const noopLog = { trace: (): void => { /* no-op */ } } as unknown as Log;

/** The fully-qualified setting id the terminal layer writes its Workspace-scope default to. */
const DEFAULT_PROFILE_ID = 'terminal.integrated.defaultProfile.linux';

// extension.ts is activation wiring only; these tests pin the two behaviours the
// reconnect-safety fix (headline #3, "post-reconnect terminals fail") introduces:
//
//   * lazyExec — the provider/reaper `exec` resolves the resolver's *current*
//     SSHConnection at call time, so a reconnect's fresh connection is used and a
//     new terminal no longer targets the dead pre-reconnect channel.
//   * idempotentResolveHandler — resolve-success fires on every (re)connect; the
//     tmux layer must be wired exactly once and only *refreshed* thereafter (never
//     re-registering the terminal profile provider, which throws "already
//     registered" and would orphan the surviving provider).
//
// The heavier activate()-level wiring tests (settings, default-profile scope,
// session-context host parse) land with those tasks + the expanded vscode mock.

/** A fake SSHConnection exposing just the `exec` this layer uses; `tag` lets a test
 * tell which connection actually answered. */
function fakeConnection(tag: string) {
    return { exec: vi.fn(async () => ({ stdout: tag, stderr: '' })) };
}

/** A resolver stub whose live connection a test can swap between exec calls (models
 * a reconnect handing the resolver a fresh `SSHConnection`). */
function fakeResolver(connection: unknown) {
    let current = connection;
    const resolver = { getSSHConnection: () => current } as unknown as RemoteSSHResolver;
    return { resolver, swap: (next: unknown): void => { current = next; } };
}

describe('lazyExec: post-reconnect exec targets the live connection', () => {
    it('resolves the resolver\'s current connection at call time, not at wire time', async () => {
        const first = fakeConnection('first');
        const second = fakeConnection('second');
        const { resolver, swap } = fakeResolver(first);
        const exec = lazyExec(resolver);

        expect((await exec('tmux ls')).stdout).toBe('first');
        swap(second); // a reconnect swaps in a fresh SSHConnection
        expect((await exec('tmux ls')).stdout).toBe('second');

        expect(first.exec).toHaveBeenCalledTimes(1);
        expect(second.exec).toHaveBeenCalledTimes(1);
    });

    it('rejects when no connection is live (provider/reaper degrade via never-throw paths)', async () => {
        const { resolver } = fakeResolver(undefined);
        await expect(lazyExec(resolver)('tmux ls')).rejects.toThrow();
    });
});

describe('tmuxExec: every tmux-layer remote call is bounded and reports its exit code', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs through the live connection with the exit-code marker, and parses it back', async () => {
        const connection = { exec: vi.fn(async () => ({ stdout: 'row\n\n__rc=0\n', stderr: '' })) };
        const { resolver } = fakeResolver(connection);

        expect(await tmuxExec(resolver)('tmux ls')).toEqual({ stdout: 'row\n', stderr: '', code: 0 });
        expect(connection.exec).toHaveBeenCalledWith(wrapWithExitCode('tmux ls'));
    });

    it('rejects with a DeadlineError after 8 s when the connection never answers', async () => {
        vi.useFakeTimers();
        const connection = { exec: vi.fn(() => new Promise(() => { /* half-dead link */ })) };
        const { resolver } = fakeResolver(connection);

        const pending = tmuxExec(resolver)('tmux ls');
        const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineError);
        await vi.advanceTimersByTimeAsync(TMUX_EXEC_DEADLINE_MS);
        await assertion;
        expect(TMUX_EXEC_DEADLINE_MS).toBe(8000);
    });
});

/** A fake wired layer, recording what the controller and the watchers do to it. */
function fakeLayer(identity: TmuxSessionContext = { hostKey: 'dev@h:22', workspaceKey: '/w', cwd: '/w' }) {
    return {
        identity,
        refresh: vi.fn(),
        reconfigure: vi.fn(),
        dispose: vi.fn(),
        protectedSessions: vi.fn(async () => []),
    } satisfies TmuxTerminalLayer;
}

describe('TmuxLayerController: wire once, refresh on reconnect, rewire/unwire at runtime', () => {
    it('wires on the first resolve, then only refreshes on every later resolve', async () => {
        const layer = fakeLayer();
        const wire = vi.fn(async () => layer);
        const controller = new TmuxLayerController(wire);

        await controller.resolved(); // first connect → wire
        await controller.resolved(); // reconnect → refresh only
        await controller.resolved(); // reconnect → refresh only

        expect(wire).toHaveBeenCalledTimes(1);   // never re-registers
        expect(layer.refresh).toHaveBeenCalledTimes(2);
    });

    it('retries wiring on a later resolve when the gates were not yet satisfied', async () => {
        const layer = fakeLayer();
        let call = 0;
        const wire = vi.fn(async () => (call++ === 0 ? undefined : layer));
        const controller = new TmuxLayerController(wire);

        await controller.resolved(); // gate failed → no layer retained
        await controller.resolved(); // now wired
        await controller.resolved(); // reconnect → refresh

        expect(wire).toHaveBeenCalledTimes(2);
        expect(layer.refresh).toHaveBeenCalledTimes(1);
    });

    it('a resolve arriving while wiring is in flight joins it instead of wiring twice', async () => {
        const wire = vi.fn(async () => fakeLayer());
        const controller = new TmuxLayerController(wire);

        await Promise.all([controller.resolved(), controller.resolved()]);

        expect(wire).toHaveBeenCalledTimes(1);
    });

    it('counts as wired while wiring is in flight', () => {
        const controller = new TmuxLayerController(() => new Promise(() => { /* identity still resolving */ }));
        void controller.resolved();

        expect(controller.wired).toBe(true);
    });

    it('unwire disposes the layer and hands back its identity', async () => {
        const layer = fakeLayer();
        const controller = new TmuxLayerController(async () => layer);
        await controller.resolved();

        expect(controller.unwire()).toBe(layer.identity);
        expect(layer.dispose).toHaveBeenCalledTimes(1);
        expect(controller.wired).toBe(false);
    });

    it('rewire disposes the old layer before building the new one', async () => {
        const first = fakeLayer();
        const second = fakeLayer();
        const layers = [first, second];
        const controller = new TmuxLayerController(async () => layers.shift());
        await controller.resolved();

        await controller.rewire();

        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(controller.current).toBe(second);
    });

    it('a wiring superseded by unwire is disposed when it lands, never kept', async () => {
        const layer = fakeLayer();
        let land!: (value: TmuxTerminalLayer) => void;
        const controller = new TmuxLayerController(() => new Promise<TmuxTerminalLayer>(resolve => {
            land = resolve;
        }));
        const wiring = controller.resolved();
        await Promise.resolve();

        controller.unwire();
        land(layer);

        expect(await wiring).toBeUndefined();
        expect(layer.dispose).toHaveBeenCalledTimes(1);
        expect(controller.current).toBeUndefined();
    });

    it('a wiring that throws leaves nothing wired and lets the next resolve retry', async () => {
        let call = 0;
        const layer = fakeLayer();
        const controller = new TmuxLayerController(async () => {
            if (call++ === 0) {
                throw new Error('boom');
            }
            return layer;
        });

        expect(await controller.resolved()).toBeUndefined();
        expect(await controller.resolved()).toBe(layer);
    });
});

describe('watchTmuxLayerInputs (05 b/h: settings and folder changes without a reload)', () => {
    const SETTINGS: TmuxSettings = {
        enabled: 'auto', historyLimit: 50000, reapOnConnect: true, handOff: 'auto', setDefaultProfile: true, orphanMaxAgeDays: 14,
    };

    function harness(over: { identity?: TmuxSessionContext | undefined; connected?: boolean } = {}) {
        let configListener: ((e: { affectsConfiguration(section: string): boolean }) => void) | undefined;
        let foldersListener: (() => void) | undefined;
        const configSub = { dispose: vi.fn() };
        const foldersSub = { dispose: vi.fn() };
        const layer = fakeLayer();
        const controller = new TmuxLayerController(async () => layer);
        let settings = SETTINGS;
        const reactions = {
            controller,
            readSettings: () => settings,
            connected: () => over.connected ?? true,
            currentIdentity: vi.fn(async () => ('identity' in over ? over.identity : layer.identity)),
            clearDefaultProfile: vi.fn(),
            offerCleanup: vi.fn(async () => undefined),
            log: { trace: vi.fn() },
        };
        const watcher = watchTmuxLayerInputs({
            onDidChangeConfiguration: listener => {
                configListener = listener;
                return configSub;
            },
            onDidChangeWorkspaceFolders: listener => {
                foldersListener = listener;
                return foldersSub;
            },
        }, reactions);
        const change = (next: Partial<TmuxSettings>, section = 'remote.SSH.tmux'): void => {
            settings = { ...settings, ...next };
            configListener!({ affectsConfiguration: (s: string) => section.startsWith(s) || s.startsWith(section) });
        };
        return { watcher, layer, controller, reactions, change, configSub, foldersSub, folders: () => foldersListener!() };
    }
    const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

    it('subscribes to both events and releases both on dispose', () => {
        const { watcher, configSub, foldersSub } = harness();

        watcher.dispose();

        expect(configSub.dispose).toHaveBeenCalledTimes(1);
        expect(foldersSub.dispose).toHaveBeenCalledTimes(1);
    });

    it('ignores configuration changes outside remote.SSH.tmux', async () => {
        const { controller, change, layer } = harness();
        await controller.resolved();

        change({ historyLimit: 1 }, 'editor.fontSize');

        expect(layer.reconfigure).not.toHaveBeenCalled();
    });

    it('turning persistent terminals off unwires, clears our default profile and offers cleanup', async () => {
        const { controller, change, layer, reactions } = harness();
        await controller.resolved();

        change({ enabled: 'off' });

        expect(layer.dispose).toHaveBeenCalledTimes(1);
        expect(reactions.clearDefaultProfile).toHaveBeenCalledTimes(1);
        expect(reactions.offerCleanup).toHaveBeenCalledWith(layer.identity);
    });

    it('turning them back on without a reload wires again', async () => {
        const { controller, change } = harness();
        await controller.resolved();
        change({ enabled: 'off' });

        change({ enabled: 'auto' });
        await settle();

        expect(controller.wired).toBe(true);
    });

    it('does not wire on a turn-on before the window is connected (the resolve will)', async () => {
        const { controller, change } = harness({ connected: false });
        change({ enabled: 'off' });

        change({ enabled: 'auto' });

        expect(controller.wired).toBe(false);
    });

    it('a live setting is handed to the wired layer', async () => {
        const { controller, change, layer } = harness();
        await controller.resolved();

        change({ historyLimit: 1234 });

        expect(layer.reconfigure).toHaveBeenCalledWith(expect.objectContaining({ historyLimit: 1234 }));
    });

    it('a folder change that keeps the identity changes nothing', async () => {
        const { controller, layer, folders } = harness();
        await controller.resolved();

        folders();
        await settle();

        expect(layer.dispose).not.toHaveBeenCalled();
    });

    it('a folder change that moves the identity rewires the layer onto it', async () => {
        const { controller, layer, folders, reactions } = harness({ identity: { hostKey: 'dev@h:22', workspaceKey: '/other', cwd: '/other' } });
        await controller.resolved();

        folders();
        await settle();

        expect(reactions.currentIdentity).toHaveBeenCalled();
        expect(layer.dispose).toHaveBeenCalledTimes(1);
        expect(controller.wired).toBe(true);
    });

    it('a folder change that leaves no folder unwires (no stale identity)', async () => {
        const { controller, layer, folders, reactions } = harness({ identity: undefined });
        await controller.resolved();

        folders();
        await settle();

        expect(layer.dispose).toHaveBeenCalledTimes(1);
        expect(reactions.clearDefaultProfile).toHaveBeenCalledTimes(1);
        expect(controller.wired).toBe(false);
    });
});

describe('offerBackgroundCleanup (05 b: what still runs after turning terminals off)', () => {
    afterEach(() => {
        shownMessages.information.length = 0;
        shownMessages.warning.length = 0;
        shownMessages.error.length = 0;
    });
    const IDENTITY: TmuxSessionContext = { hostKey: 'dev@h:22', workspaceKey: '/w', cwd: '/w', legacy: { hostKey: 'h', workspaceKey: '/w/' } };

    it('words the offer without internals, singular and plural', () => {
        expect(backgroundTerminalsMessage(1)).toBe('1 background terminal from this workspace is still running.');
        expect(backgroundTerminalsMessage(3)).toBe('3 background terminals from this workspace are still running.');
        expect(backgroundTerminalsMessage(3)).not.toMatch(/tmux|session/i);
    });

    it('asks once, and closes them (canonical + legacy identities) on "Close them"', async () => {
        const reaper = { countWorkspaceSessions: vi.fn(async () => 2), killWorkspaceSessions: vi.fn(async () => ({ killed: 2, failed: 0 })) };
        const ask = vi.fn(async () => CLOSE_BACKGROUND_TERMINALS);

        await offerBackgroundCleanup(IDENTITY, { reaper, ask });

        expect(ask).toHaveBeenCalledWith(backgroundTerminalsMessage(2), CLOSE_BACKGROUND_TERMINALS, KEEP_BACKGROUND_TERMINALS);
        expect(reaper.killWorkspaceSessions).toHaveBeenCalledWith([
            { hostKey: 'dev@h:22', workspaceKey: '/w' },
            { hostKey: 'h', workspaceKey: '/w/' },
        ]);
    });

    it.each([KEEP_BACKGROUND_TERMINALS, undefined])('keeps them on %j', async (answer) => {
        const reaper = { countWorkspaceSessions: vi.fn(async () => 2), killWorkspaceSessions: vi.fn() };

        await offerBackgroundCleanup(IDENTITY, { reaper, ask: async () => answer });

        expect(reaper.killWorkspaceSessions).not.toHaveBeenCalled();
    });

    it.each([0, undefined])('does not ask when there is nothing (or nothing known) running: %j', async (count) => {
        const ask = vi.fn();

        await offerBackgroundCleanup(IDENTITY, { reaper: { countWorkspaceSessions: async () => count, killWorkspaceSessions: vi.fn() }, ask });

        expect(ask).not.toHaveBeenCalled();
    });
});

describe('maybeWarnTerminalLifetime (05 k: a host that ends processes at logout)', () => {
    function deps(over: { risk?: boolean; dismissed?: string[] } = {}) {
        const store = new Map<string, unknown>(over.dismissed ? [['tmux.lifetimeWarningDismissed.v1', over.dismissed]] : []);
        return {
            probe: vi.fn(async () => ({ lifetimeRisk: over.risk ?? true })),
            state: {
                get: <T>(key: string, fallback: T): T => (store.has(key) ? store.get(key) as T : fallback),
                update: vi.fn(async (key: string, value: unknown) => {
                    store.set(key, value);
                }),
            },
            show: vi.fn(async (): Promise<string | undefined> => undefined),
            openDocs: vi.fn(),
            log: { trace: vi.fn() },
            store,
        };
    }

    it('warns once, in plain words, and remembers the dismissal for this host', async () => {
        const d = deps();

        await maybeWarnTerminalLifetime('dev@h:22', d);

        expect(d.show).toHaveBeenCalledWith(LIFETIME_WARNING_MESSAGE, LIFETIME_LEARN_MORE);
        expect(LIFETIME_WARNING_MESSAGE).not.toMatch(/tmux|session|systemd|logind/i);
        expect(d.store.get('tmux.lifetimeWarningDismissed.v1')).toEqual(['dev@h:22']);
    });

    it('opens the troubleshooting entry on "Learn more"', async () => {
        const d = deps();
        d.show.mockResolvedValue(LIFETIME_LEARN_MORE);

        await maybeWarnTerminalLifetime('dev@h:22', d);

        expect(d.openDocs).toHaveBeenCalledWith(LIFETIME_DOCS_URL);
        expect(LIFETIME_DOCS_URL).toMatch(/docs\/troubleshooting\.md#terminals-closed-after-disconnect$/);
    });

    it('never asks again for a host already dismissed (not even probing)', async () => {
        const d = deps({ dismissed: ['dev@h:22'] });

        await maybeWarnTerminalLifetime('dev@h:22', d);

        expect(d.probe).not.toHaveBeenCalled();
        expect(d.show).not.toHaveBeenCalled();
    });

    it('stays silent when there is no risk', async () => {
        const d = deps({ risk: false });

        await maybeWarnTerminalLifetime('dev@h:22', d);

        expect(d.show).not.toHaveBeenCalled();
    });
});

describe('canonical identity (05 c: the same target reached by alias or address is one identity)', () => {
    it('an alias resolves through HostName/User/Port to what typing the address gives', () => {
        const viaAlias = resolveSshTarget(new SSHDestination('myvps'), { HostName: '203.0.113.7', User: 'dev' }, 'local');
        const viaAddress = resolveSshTarget(new SSHDestination('203.0.113.7', 'dev'), {}, 'local');

        expect(viaAlias).toEqual(viaAddress);
        expect(viaAlias).toEqual({ hostName: '203.0.113.7', user: 'dev', port: 22 });
    });

    it('expands %h in HostName against the host as typed', () => {
        expect(resolveSshTarget(new SSHDestination('box'), { HostName: '%h.lan' }, 'local').hostName).toBe('box.lan');
    });

    it('takes the config Port, then the typed one, then 22; the local user last', () => {
        expect(resolveSshTarget(new SSHDestination('h', undefined, 2200), { Port: '2222' }, 'me').port).toBe(2222);
        expect(resolveSshTarget(new SSHDestination('h', undefined, 2200), {}, 'me').port).toBe(2200);
        expect(resolveSshTarget(new SSHDestination('h'), {}, 'me')).toEqual({ hostName: 'h', user: 'me', port: 22 });
    });

    it('builds the provider context: canonical keys, raw path as cwd, legacy kept for adoption', () => {
        const ctx = canonicalTmuxIdentity({ hostKey: 'myvps', workspaceKey: '/home/dev/proj/' }, { hostName: 'H', user: 'dev', port: 22 });

        expect(ctx).toEqual({
            hostKey: 'dev@h:22',
            workspaceKey: '/home/dev/proj',
            cwd: '/home/dev/proj/',
            legacy: { hostKey: 'myvps', workspaceKey: '/home/dev/proj/' },
        });
    });
});

// The connect-time image sweep used to live inside `wireTmuxTerminalLayer`, which tied
// housekeeping for pasted screenshots to a gate that has nothing to do with it: pasting
// needs only a remote authority, but the sweep ran only when the tmux layer wired. With
// `remote.SSH.tmux.enabled: "off"`, a remote without tmux, or an empty remote window,
// images uploaded fine and nothing ever deleted them. It is now composed into the
// resolve-success callback alongside the wiring, and must run exactly once per window.
describe('onceOnly: connect-time housekeeping that must not repeat on reconnect', () => {
    it('runs on the first call and never again', () => {
        const action = vi.fn();
        const once = onceOnly(action);

        once();
        once();
        once();

        expect(action).toHaveBeenCalledTimes(1);
    });

    it('does not run until it is called', () => {
        const action = vi.fn();
        onceOnly(action);
        expect(action).not.toHaveBeenCalled();
    });

    it('stays spent even when the action throws', () => {
        const action = vi.fn(() => { throw new Error('sweep exploded'); });
        const once = onceOnly(action);

        // A throwing sweep must not arm itself to be retried on every later reconnect.
        expect(() => once()).toThrow('sweep exploded');
        expect(() => once()).not.toThrow();
        expect(action).toHaveBeenCalledTimes(1);
    });
});

// The four settings (`historyLimit`, `reapOnConnect`, `enabled`, `setDefaultProfile`)
// are read together so configuration controls wiring, cleanup, and default-profile writes.
// `readTmuxSettings` is the single read seam (pins section, key names, and the
// package.json defaults) and `decideTmuxWiring` is the pure enablement rule that
// makes `enabled:'on'` ("require tmux") observably different from `'auto'`.
describe('readTmuxSettings: the four remote.SSH.tmux.* settings are read', () => {
    beforeEach(() => configOverrides.clear());

    it('reads orphanMaxAgeDays (default 14, 0 allowed, garbage → default)', () => {
        expect(readTmuxSettings().orphanMaxAgeDays).toBe(14);
        configOverrides.set('remote.SSH.tmux.orphanMaxAgeDays', 0);
        expect(readTmuxSettings().orphanMaxAgeDays).toBe(0);
        configOverrides.set('remote.SSH.tmux.orphanMaxAgeDays', 30);
        expect(readTmuxSettings().orphanMaxAgeDays).toBe(30);
        for (const bad of [-1, 2.5, '7', null]) {
            configOverrides.set('remote.SSH.tmux.orphanMaxAgeDays', bad);
            expect(readTmuxSettings().orphanMaxAgeDays).toBe(14);
        }
    });

    it('falls back to the package.json defaults when nothing is configured', () => {
        const settings = readTmuxSettings();
        expect(settings.enabled).toBe('auto');
        expect(settings.historyLimit).toBe(50000);
        expect(settings.reapOnConnect).toBe(true);
        expect(settings.setDefaultProfile).toBe(true);
        expect(settings.handOff).toBe('auto');
    });

    it.each(['auto', 'ask', 'never'])('reads remote.SSH.tmux.handOff=%s', (handOff) => {
        configOverrides.set('remote.SSH.tmux.handOff', handOff);
        expect(readTmuxSettings().handOff).toBe(handOff);
    });

    it('falls back to auto for an unrecognised handOff value', () => {
        configOverrides.set('remote.SSH.tmux.handOff', 'sometimes');
        expect(readTmuxSettings().handOff).toBe('auto');
    });

    it.each([false, true])('reads seeded values with setDefaultProfile=%s from the remote.SSH configuration section', (setDefaultProfile) => {
        configOverrides.set('remote.SSH.tmux.enabled', 'on');
        configOverrides.set('remote.SSH.tmux.historyLimit', 1000);
        configOverrides.set('remote.SSH.tmux.reapOnConnect', false);
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', setDefaultProfile);

        const settings = readTmuxSettings();
        expect(settings.enabled).toBe('on');
        expect(settings.historyLimit).toBe(1000);
        expect(settings.reapOnConnect).toBe(false);
        expect(settings.setDefaultProfile).toBe(setDefaultProfile);
    });

    // A value tmux rejects used to abort the attach chain before `new-session`, so no
    // terminal could open. The read seam clamps, so no setting can stop a terminal.
    it.each([
        [1.5, 50000],
        [-1, 50000],
        [1e10, 1_000_000],
        ['5000', 50000],
    ] as const)('clamps historyLimit %j to %j', (configured, expected) => {
        configOverrides.set('remote.SSH.tmux.historyLimit', configured);
        expect(readTmuxSettings().historyLimit).toBe(expected);
    });
});

describe('decideTmuxWiring: enabled setting × tmux availability', () => {
    const AVAILABLE = { available: true } as const;
    const MISSING = { available: false, reason: 'not-installed' } as const;
    const UNREACHABLE = { available: false, reason: 'unreachable' } as const;

    it('off → skip, whether or not tmux is available', () => {
        expect(decideTmuxWiring('off', AVAILABLE)).toBe('skip');
        expect(decideTmuxWiring('off', MISSING)).toBe('skip');
        expect(decideTmuxWiring('off', UNREACHABLE)).toBe('skip');
    });

    it('auto → wire when available, skip silently when not', () => {
        expect(decideTmuxWiring('auto', AVAILABLE)).toBe('wire');
        expect(decideTmuxWiring('auto', MISSING)).toBe('skip');
    });

    it('on → wire when available, require-error when not (the "fail if unavailable" contract)', () => {
        expect(decideTmuxWiring('on', AVAILABLE)).toBe('wire');
        expect(decideTmuxWiring('on', MISSING)).toBe('require-error');
        expect(decideTmuxWiring('on', { available: false, reason: 'too-old' })).toBe('require-error');
        expect(decideTmuxWiring('on', undefined)).toBe('require-error');
    });

    // A probe that could not be asked (channel error, missed deadline) is not evidence that
    // tmux is missing. Telling an `'on'` user to "install tmux" would be false — and would
    // leak tmux wording for a transient condition. Plain shells this resolve, retry next.
    it('unreachable → retry silently, never require-error, under on and auto alike', () => {
        expect(decideTmuxWiring('on', UNREACHABLE)).toBe('retry');
        expect(decideTmuxWiring('auto', UNREACHABLE)).toBe('retry');
    });

    it('an unknown value degrades to auto behaviour', () => {
        expect(decideTmuxWiring('weird', AVAILABLE)).toBe('wire');
        expect(decideTmuxWiring('weird', MISSING)).toBe('skip');
    });
});

describe('clipboardExec: the image paste/sweep commands are deadline-bounded too', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes the raw result through untouched (no exit-code wrapping for the clipboard)', async () => {
        const connection = { exec: vi.fn(async () => ({ stdout: '/home/u\n', stderr: '' })) };
        const { resolver } = fakeResolver(connection);

        expect(await clipboardExec(resolver, CLIPBOARD_PASTE_DEADLINE_MS)('printf %s "$HOME"'))
            .toEqual({ stdout: '/home/u\n', stderr: '' });
        expect(connection.exec).toHaveBeenCalledWith('printf %s "$HOME"');
    });

    it.each([
        ['paste', CLIPBOARD_PASTE_DEADLINE_MS, 60000],
        ['sweep', CLIPBOARD_SWEEP_DEADLINE_MS, 15000],
    ])('rejects with a DeadlineError once the %s deadline passes', async (_label, deadline, expected) => {
        expect(deadline).toBe(expected);
        vi.useFakeTimers();
        const connection = { exec: vi.fn(() => new Promise(() => { /* half-dead link */ })) };
        const { resolver } = fakeResolver(connection);

        const pending = clipboardExec(resolver, deadline)('true');
        const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineError);
        await vi.advanceTimersByTimeAsync(deadline);
        await assertion;
    });
});

// `terminal.integrated.defaultProfile.linux` is the one settings write the terminal layer
// makes — Workspace scope only. The old check inspected `workspaceValue` alone, so a
// User/Global (or remote-user) default was silently clobbered by the Workspace write, and a
// stale write was never removed when tmux went off/unavailable (leaving the default pointing
// at an unregistered profile). `decideDefaultProfile` is the pure rule; `reconcile…` applies it.
describe('decideDefaultProfile: workspace default-profile write vs. user scopes', () => {
    it('wiring + nothing set at any scope → set', () => {
        expect(decideDefaultProfile(undefined, true)).toBe('set');
        expect(decideDefaultProfile({}, true)).toBe('set');
    });

    it('wiring + a user default at any scope → none (never override)', () => {
        expect(decideDefaultProfile({ workspaceValue: 'zsh' }, true)).toBe('none');
        expect(decideDefaultProfile({ globalValue: 'zsh' }, true)).toBe('none');
        expect(decideDefaultProfile({ workspaceFolderValue: 'zsh' }, true)).toBe('none');
    });

    it('wiring + only our own prior workspace write present → none (idempotent, no re-write)', () => {
        expect(decideDefaultProfile({ workspaceValue: TMUX_PROFILE_TITLE }, true)).toBe('none');
    });

    it('not wiring + our own stale workspace write → clear', () => {
        expect(decideDefaultProfile({ workspaceValue: TMUX_PROFILE_TITLE }, false)).toBe('clear');
    });

    it('not wiring + a user workspace choice → none (never remove the user\'s value)', () => {
        expect(decideDefaultProfile({ workspaceValue: 'zsh' }, false)).toBe('none');
    });

    it('not wiring + nothing set → none', () => {
        expect(decideDefaultProfile(undefined, false)).toBe('none');
        expect(decideDefaultProfile({}, false)).toBe('none');
    });

    it('not wiring + a global value (not ours to clean) → none', () => {
        expect(decideDefaultProfile({ globalValue: TMUX_PROFILE_TITLE }, false)).toBe('none');
    });
});

// `currentTmuxSessionContext` keyed the session hash off `vscode.env.remoteName`, which is
// the remote *type* ('ssh-remote') and identical for every SSH host — so tmuxSession.ts's
// host+workspace identity collapsed to workspace-only, and the cwd fell back to a fabricated
// literal `/home/user`. `deriveTmuxSessionContext` is the pure seam: it decodes the real host
// from the `ssh-remote+<encoded-dest>` authority the resolver put on the workspace-folder URI
// (SSHDestination.parseEncoded, exactly as getRemoteWorkspaceLocationData does), and keys the
// cwd to the real folder path — no fabrication.
describe('deriveTmuxSessionContext: (host, workspace) parsed from the resolved authority', () => {
    /** Build the `ssh-remote+<hex-json>` authority VS Code carries for a resolved host. */
    function remoteFolder(hostName: string, path: string, user = 'me', port = 22) {
        const encoded = Buffer.from(JSON.stringify({ hostName, user, port })).toString('hex');
        return { scheme: 'vscode-remote', authority: `ssh-remote+${encoded}`, path };
    }

    it('parses the real hostname from the authority, never the literal "ssh-remote" type', () => {
        const ctx = deriveTmuxSessionContext(remoteFolder('prod.example.com', '/home/deploy/app'));
        expect(ctx).toEqual({ hostKey: 'prod.example.com', workspaceKey: '/home/deploy/app' });
        expect(ctx?.hostKey).not.toBe('ssh-remote'); // the bug this fixes
    });

    it('decodes an \\x-escaped (uppercase-preserving) authority form too', () => {
        // SSHDestination.toEncodedString() escapes uppercase as \xHH (M=0x4d, H=0x48);
        // parseEncoded reverses it, so we must not naively read the authority verbatim.
        const ctx = deriveTmuxSessionContext({ scheme: 'vscode-remote', authority: 'ssh-remote+\\x4dy\\x48ost', path: '/w' });
        expect(ctx?.hostKey).toBe('MyHost');
    });

    it('keys workspaceKey to the folder path (the tmux -c cwd), never a fabricated /home/user', () => {
        const ctx = deriveTmuxSessionContext(remoteFolder('h', '/srv/project'));
        expect(ctx?.workspaceKey).toBe('/srv/project');
    });

    it('gives two hosts sharing a workspace path distinct identities (host is part of the key)', () => {
        const a = deriveTmuxSessionContext(remoteFolder('host-a', '/home/me/app'));
        const b = deriveTmuxSessionContext(remoteFolder('host-b', '/home/me/app'));
        expect(a?.hostKey).toBe('host-a');
        expect(b?.hostKey).toBe('host-b');
        expect(a?.hostKey).not.toBe(b?.hostKey);
    });

    it('returns undefined with no workspace folder (empty window — nothing to key, nothing fabricated)', () => {
        expect(deriveTmuxSessionContext(undefined)).toBeUndefined();
    });

    it('returns undefined for a non-remote (local) folder', () => {
        expect(deriveTmuxSessionContext({ scheme: 'file', authority: '', path: '/local' })).toBeUndefined();
    });

    it('returns undefined for a different remote type (not ssh-remote, e.g. WSL)', () => {
        expect(deriveTmuxSessionContext({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/w' })).toBeUndefined();
    });

    it('returns undefined for an empty/undecodable host (ssh-remote+ with nothing after)', () => {
        expect(deriveTmuxSessionContext({ scheme: 'vscode-remote', authority: 'ssh-remote+', path: '/w' })).toBeUndefined();
    });
});

describe('reconcileDefaultTerminalProfile: applies the decision to Workspace scope only', () => {
    beforeEach(() => {
        configOverrides.clear();
        inspectOverrides.clear();
        updateCalls.length = 0;
    });

    it('wiring + nothing set → one Workspace-scope write of the tmux profile', () => {
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: TMUX_PROFILE_TITLE, target: ConfigurationTarget.Workspace },
        ]);
    });

    it('wiring + explicit setDefaultProfile=true + nothing set → one Workspace-scope write', () => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', true);
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: TMUX_PROFILE_TITLE, target: ConfigurationTarget.Workspace },
        ]);
    });

    it('wiring + setDefaultProfile=false + nothing set → no write', () => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', false);
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toHaveLength(0);
    });

    it('wiring + a Workspace default already set → no write', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: 'zsh' });
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toHaveLength(0);
    });

    it('wiring + a User/Global default set → no write (a Workspace write would clobber it)', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { globalValue: 'zsh' });
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toHaveLength(0);
    });

    it('not wiring + a stale write of ours → one Workspace-scope removal (undefined)', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: TMUX_PROFILE_TITLE });
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: undefined, target: ConfigurationTarget.Workspace },
        ]);
    });

    it('not wiring + setDefaultProfile=false + our stale Workspace default → still clear', () => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', false);
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: TMUX_PROFILE_TITLE });
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: undefined, target: ConfigurationTarget.Workspace },
        ]);
    });

    it.each([
        { workspaceValue: 'zsh' },
        { globalValue: 'zsh' },
        { workspaceFolderValue: 'zsh' },
        { globalValue: TMUX_PROFILE_TITLE },
    ])('not wiring + setDefaultProfile=false preserves user scopes %j', (scopes) => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', false);
        inspectOverrides.set(DEFAULT_PROFILE_ID, scopes);
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toHaveLength(0);
    });

    it('not wiring + nothing of ours to clean → no write', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: 'zsh' });
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toHaveLength(0);
    });
});

// When tmux is unavailable or disabled, the "Persistent Shell" profile should still be
// available (via a fallback plain-shell provider) so the user sees the profile in the
// terminal picker even if tmux is not working. This prevents "Profile not found" errors
// and provides graceful degradation when the setting is 'off' or the remote lacks tmux.
// activate() seeds the shared TerminalProfileRegistration with this provider (before the
// tmux-gated wiring), and wireTmuxTerminalLayer *swaps* the real TmuxTerminalProvider in
// once wired. It is a swap, not a second registration: VS Code allows one provider per
// profile id and throws "already registered" otherwise — the v1.0.0 bug this fallback was
// silently masking. See test/tmux/profileRegistration.test.ts.
// VS Code picks the `terminal.integrated.defaultProfile.<suffix>` suffix from the REMOTE
// operating system, not from "is this a Unix host" — its terminal profile service resolves
// the suffix via the remote agent environment (`windows` / `osx` / `linux`). The layer
// hardcoded `.linux`, so on a macOS remote — which IS wired, since the tmux probe only gates
// off an explicit `windows` platform — the write went to a key VS Code never reads. The
// profile registered fine but "New Terminal" opened a plain non-persistent shell, and the
// user had to pick "Persistent Shell" from the dropdown every single time. The mirror
// cleanup path and the "did the user already set a default?" inspection were equally inert.
describe('defaultProfileSettingKey: the suffix follows the REMOTE platform', () => {
    it('maps macOS remotes to the osx suffix, not linux', () => {
        expect(defaultProfileSettingKey('macos')).toBe('defaultProfile.osx');
        expect(defaultProfileSettingKey('darwin')).toBe('defaultProfile.osx');
    });

    it('maps Windows remotes to the windows suffix', () => {
        expect(defaultProfileSettingKey('windows')).toBe('defaultProfile.windows');
    });

    it('maps Linux and other Unix remotes to the linux suffix', () => {
        expect(defaultProfileSettingKey('linux')).toBe('defaultProfile.linux');
        expect(defaultProfileSettingKey('freebsd')).toBe('defaultProfile.linux');
    });

    // An unlabelled platform is treated as a Unix remote everywhere else in this codebase
    // (see tmuxBootstrap's gate, which only short-circuits on the literal 'windows'), so the
    // default here must agree rather than invent a third behaviour.
    it('defaults to linux when the remote platform is unknown', () => {
        expect(defaultProfileSettingKey(undefined)).toBe('defaultProfile.linux');
    });
});

describe('FallbackTerminalProvider: graceful degradation when tmux is not wired', () => {
    it('provides a plain vscode.TerminalProfile (no tmux shell/args) synchronously', () => {
        const provider = new FallbackTerminalProvider();
        const profile = provider.provideTerminalProfile();

        expect(profile).toBeInstanceOf(TerminalProfile);
        // No special shellPath/shellArgs/cwd — VS Code falls back to its own default shell.
        expect((profile as InstanceType<typeof TerminalProfile>).options).toEqual({});
    });

    it('returns a fresh profile instance on every call (no shared/stale state)', () => {
        const provider = new FallbackTerminalProvider();
        expect(provider.provideTerminalProfile()).not.toBe(provider.provideTerminalProfile());
    });
});

describe('hand-off UI and window close (03)', () => {
    afterEach(() => {
        vi.useRealTimers();
        shownMessages.information.length = 0;
        messageResponses.information = undefined;
    });

    // One non-modal notification, no tmux wording; only an explicit "Take over" counts.
    it('offers with one plain-language notification and two buttons', async () => {
        messageResponses.information = HAND_OFF_TAKE_OVER;

        expect(await offerHandOff()).toBe(true);
        expect(shownMessages.information).toEqual([[HAND_OFF_OFFER_MESSAGE, HAND_OFF_TAKE_OVER, HAND_OFF_NOT_NOW]]);
        expect(HAND_OFF_OFFER_MESSAGE).not.toMatch(/tmux|session|detach/i);
    });

    it.each([HAND_OFF_NOT_NOW, undefined])('treats %j as not now', async (answer) => {
        messageResponses.information = answer;
        expect(await offerHandOff()).toBe(false);
    });

    it('bounds the detach on close and never rejects when it hangs', async () => {
        vi.useFakeTimers();
        const settled = detachBeforeExit(() => new Promise<void>(() => { /* half-dead link */ }));
        vi.advanceTimersByTime(DETACH_ON_CLOSE_DEADLINE_MS);
        await expect(settled).resolves.toBeUndefined();
    });

    it('never rejects when the detach fails', async () => {
        await expect(detachBeforeExit(() => Promise.reject(new Error('closed')))).resolves.toBeUndefined();
    });

    it('keeps the close short', () => {
        expect(DETACH_ON_CLOSE_DEADLINE_MS).toBeLessThanOrEqual(2000);
    });

    it('does nothing on deactivate when the tmux layer never wired', () => {
        expect(deactivate()).toBeUndefined();
    });
});
