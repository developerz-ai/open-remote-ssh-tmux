// Deliberately broken: a promise nobody awaits or catches. test/eslint-gate.test.ts lints
// this as if it lived under src/ and expects the floating-promise rule to fail the run.
async function fetchSomething(): Promise<number> {
    return 1;
}

export function caller(): void {
    fetchSomething();
}
