// The Stake PDEX card's simple view (WP2 of design 2026-11-22-stake-card-simple-and-advanced.md).
// Stub: the red commit declares the module; the green commit builds it.

export function createStakeCard() {
    return { open() { return 0; }, setSnapshot() {}, setPayee() {}, markManual() {}, render() {}, recheck: async () => true, view: () => 'simple' };
}
