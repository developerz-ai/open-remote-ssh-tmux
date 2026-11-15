import { beforeEach, describe, expect, it } from 'vitest';
import {
    acceptedAction, ADD_HOST_LABEL, buildConnectItems, CONFIGURE_HOSTS_LABEL, pickConnectDestination, typedItem,
    type ConnectPickItem, type ConnectPickSources,
} from '../src/connectQuickPick';
import { createdQuickPicks, QuickPickItemKind, type MockQuickPick } from './mocks/vscode';

// "Connect to Host..." used to be a bare input box: the user had to remember and type every
// host. It is now a pick — recent hosts first, then the rest of the SSH config, then "Add New
// SSH Host..." / "Configure SSH Hosts..." — and typing an unlisted [user@]host[:port] still
// connects to it, as the input box did.

const addresses: Record<string, string> = { dev: 'john@dev.example.com', staging: 'ops@10.0.0.5:2222' };
const sources = (recent: string[], hosts: string[]): ConnectPickSources => ({
    recent,
    hosts,
    address: host => addresses[host] ?? host,
});

const labels = (items: readonly ConnectPickItem[]): string[] =>
    items.map(item => (item.kind === QuickPickItemKind.Separator ? `--${item.label}` : item.label));

describe('buildConnectItems', () => {
    it('lists recent hosts first, then the remaining hosts, then the add/configure entries', () => {
        expect(labels(buildConnectItems(sources(['staging'], ['dev', 'staging', 'box'])))).toEqual([
            '--recently connected', 'staging',
            '--other hosts', 'dev', 'box',
            '--', ADD_HOST_LABEL, CONFIGURE_HOSTS_LABEL,
        ]);
    });

    it('needs no group headings when nothing was connected to yet', () => {
        expect(labels(buildConnectItems(sources([], ['dev'])))).toEqual(['dev', '--', ADD_HOST_LABEL, CONFIGURE_HOSTS_LABEL]);
    });

    it('still offers add/configure with no hosts at all', () => {
        expect(labels(buildConnectItems(sources([], [])))).toEqual(['--', ADD_HOST_LABEL, CONFIGURE_HOSTS_LABEL]);
    });

    it('describes each host by the address it resolves to, unless that is the host itself', () => {
        const items = buildConnectItems(sources(['dev'], ['box']));
        expect(items.find(item => item.label === 'dev')?.description).toBe('john@dev.example.com');
        expect(items.find(item => item.label === 'box')?.description).toBeUndefined();
    });

    it('carries the action each entry runs', () => {
        const items = buildConnectItems(sources([], ['dev']));
        expect(items.find(item => item.label === 'dev')?.action).toEqual({ kind: 'connect', destination: 'dev' });
        expect(items.find(item => item.label === ADD_HOST_LABEL)?.action).toEqual({ kind: 'add' });
        expect(items.find(item => item.label === CONFIGURE_HOSTS_LABEL)?.action).toEqual({ kind: 'configure' });
    });
});

describe('typedItem', () => {
    const items = buildConnectItems(sources([], ['dev']));

    it('offers an unlisted destination as typed', () => {
        expect(typedItem(' me@new.example.com:2222 ', items)).toMatchObject({
            label: 'me@new.example.com:2222',
            alwaysShow: true,
            action: { kind: 'connect', destination: 'me@new.example.com:2222' },
        });
    });

    it('adds nothing for a listed host, blank input, or input with no hostname', () => {
        expect(typedItem('dev', items)).toBeUndefined();
        expect(typedItem('   ', items)).toBeUndefined();
        expect(typedItem('@:22', items)).toBeUndefined();
    });
});

describe('acceptedAction', () => {
    it('runs the selected entry', () => {
        expect(acceptedAction({ label: 'x', action: { kind: 'add' } }, 'whatever')).toEqual({ kind: 'add' });
    });

    it('connects to the typed value when nothing is selected', () => {
        expect(acceptedAction(undefined, ' host ')).toEqual({ kind: 'connect', destination: 'host' });
    });

    it('does nothing with nothing selected and nothing typed', () => {
        expect(acceptedAction(undefined, '  ')).toBeUndefined();
    });
});

describe('pickConnectDestination', () => {
    let added = 0;
    let configured = 0;
    const actions = {
        add: (): Promise<void> => {
            added++;
            return Promise.resolve();
        },
        configure: (): Promise<void> => {
            configured++;
            return Promise.resolve();
        },
    };

    beforeEach(() => {
        createdQuickPicks.length = 0;
        added = 0;
        configured = 0;
    });

    /** Start the pick and wait until it is on screen. */
    async function open(recent: string[], hosts: string[]): Promise<{ result: Promise<string | undefined>; pick: MockQuickPick<ConnectPickItem> }> {
        const result = pickConnectDestination(() => Promise.resolve(sources(recent, hosts)), actions);
        await new Promise(resolve => setTimeout(resolve, 0));
        const pick = createdQuickPicks.at(-1) as MockQuickPick<ConnectPickItem>;
        expect(pick.shown).toBe(true);
        return { result, pick };
    }

    it('resolves the chosen host and closes the pick', async () => {
        const { result, pick } = await open(['dev'], ['dev', 'box']);
        pick.accept(pick.items.find(item => item.label === 'box'));
        await expect(result).resolves.toBe('box');
        expect(pick.shown).toBe(false);
        expect(pick.disposed).toBe(true);
    });

    it('offers and connects to a typed, unlisted destination', async () => {
        const { result, pick } = await open([], ['dev']);
        pick.type('me@fresh:2200');
        const typed = pick.items.find(item => item.label === 'me@fresh:2200');
        expect(typed).toBeDefined();
        pick.accept(typed);
        await expect(result).resolves.toBe('me@fresh:2200');
    });

    it('drops the typed entry again when the input is cleared', async () => {
        const { pick } = await open([], ['dev']);
        pick.type('fresh');
        pick.type('');
        expect(labels(pick.items)).toEqual(['dev', '--', ADD_HOST_LABEL, CONFIGURE_HOSTS_LABEL]);
        pick.hide();
    });

    it('runs "Add New SSH Host..." and resolves nothing to connect to', async () => {
        const { result, pick } = await open([], ['dev']);
        pick.accept(pick.items.find(item => item.label === ADD_HOST_LABEL));
        await expect(result).resolves.toBeUndefined();
        expect(added).toBe(1);
    });

    it('runs "Configure SSH Hosts..." and resolves nothing to connect to', async () => {
        const { result, pick } = await open([], ['dev']);
        pick.accept(pick.items.find(item => item.label === CONFIGURE_HOSTS_LABEL));
        await expect(result).resolves.toBeUndefined();
        expect(configured).toBe(1);
    });

    it('resolves undefined when dismissed', async () => {
        const { result, pick } = await open([], ['dev']);
        pick.hide();
        await expect(result).resolves.toBeUndefined();
        expect(pick.disposed).toBe(true);
    });
});
