# 03 — host-key verification

> Part of [`overview.md`](overview.md). Depends on: none. **Critical security fix.**

Upstream ships with **no host-key verification**: neither `SSHConnection` config
(`src/authResolver.ts:216-226`, `:256-266` for ProxyJump hops) sets ssh2's
`hostVerifier`, and `src/ssh/hostfile.ts` has zero callers. Any MITM is accepted
silently. This slice wires verification with a first-connect consent prompt and
fixes the latent bugs in `hostfile.ts` so it actually works.

## Files to change
- `src/ssh/hostfile.ts:33` — missing `await`: `if (!folderExists(...))` is always-truthy Promise → `mkdir` never runs → `appendFile` ENOENT on machines without `~/.ssh`. Fix + `{ recursive: true, mode: 0o700 }`.
- `src/ssh/hostfile.ts:13` — `readFile` with no ENOENT guard: fresh machine (no `known_hosts`) rejects instead of "host is new". Treat ENOENT as empty.
- `src/ssh/hostfile.ts:15-27` — `checkNewHostInHostkeys` matches only hashed `|1|` lines → plaintext and `[host]:port` entries reported "new" → duplicate appends every connect. Match unhashed hostname fields (comma lists, `[host]:port` form) too.
- `src/ssh/hostfile.ts` (module) — hardcoded `~/.ssh/known_hosts` path blocks unit testing; accept an injected path (default unchanged). Keep this file the only known_hosts owner (SRP).
- `src/authResolver.ts:216-226,256-266` — pass a `hostVerifier` on **both** connection configs (destination + every ProxyJump hop): known key → accept; unknown → modal consent prompt (fingerprint shown, OpenSSH-style wording) → on accept, record via `addHostToHostFile`; changed key → hard fail with a mismatch warning, no bypass button. Prompting is UI → keep the verifier's decision logic pure (in `hostfile.ts` or a small helper) and inject the prompt as a callback so it's testable.

## Steps
1. TDD `hostfile.ts` fixes (path injected, tmp fixtures).
2. TDD the pure verify-decision helper: `(key, knownHosts) → 'known' | 'unknown' | 'mismatch'`.
3. Wire `hostVerifier` into both configs in `authResolver.ts`; prompt on `'unknown'`, reject on `'mismatch'`, silent on `'known'`. Record accepted keys (respect port: `[host]:port` form for non-22).
4. Minimal-diff in `authResolver.ts` (upstream file — no reformatting).

## Tests (write first — TDD)
- `checkNewHostInHostkeys`: hashed entry for host → known; hashed for other host → new; **plaintext** entry → known (pins the fix); `[host]:2222` entry → known for that port; comma-list `a.com,b.com` → both known; malformed/blank lines → no throw; missing file → new.
- `addHostToHostFile` → round-trip: add then check → known; no `~/.ssh` dir → created `0700`.
- Decision helper: same key bytes → known; different key for known host → mismatch; unseen host → unknown.
- Commands: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint/bundle clean.
- F5/EDH: first connect to a host → fingerprint prompt, accept → connects, entry written; reconnect → no prompt; hand-edit the recorded key → connect blocked with mismatch error. ProxyJump hop gets the same treatment.

## Done when
- No ssh2 connection in the codebase is created without a `hostVerifier`; mismatch cannot be clicked through; `hostfile.ts` has no dead code and full unit coverage.
