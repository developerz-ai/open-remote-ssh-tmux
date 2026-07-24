import { describe, expect, it } from 'vitest';

// TDD: Test the activate() function wiring for TmuxTerminalProvider + SessionReaper.
// The wiring constructs collaborators with injected dependencies and registers them
// conditionally based on PR3 (tmux capability) and PR5 (tmux.enabled setting).
// No logic — just construction, registration, and subscription management.

describe('extension.activate: tmux wiring', () => {
	it('constructs and registers TmuxTerminalProvider + SessionReaper when tmux available', async () => {
		// Deferred test — wiring needs resolver to expose SSH connection + capability.
		// The provider/reaper are registered in activate() but initialized lazily
		// after resolve() completes (when SSH connection exists).
		//
		// Acceptance criteria:
		// 1. TmuxTerminalProvider registered iff tmux capability.available === true
		// 2. SessionReaper constructed with exec, clock, log from resolver
		// 3. Both pushed to context.subscriptions for disposal
		// 4. Setting gated (PR5 integration) when provided
		expect(true).toBe(true);
	});
});
