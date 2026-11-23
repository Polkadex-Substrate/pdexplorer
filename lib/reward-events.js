// R2 stub (red commit): the forward pass's reward notes. Implemented in the green commit.
export const REWARD_NOTES_MAX_PER_BLOCK = 2048;
export function rewardNotesForBlock() { return { pairs: [], stale: [], seen: 0, truncated: false }; }
export function storedRewardStash() { return null; }
