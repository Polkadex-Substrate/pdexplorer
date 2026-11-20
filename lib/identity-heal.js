// Stub for the red commit: the healing pass is written in the next commit.
export const HEAL_KEY = 'identity-heal:pending';
export function noteUnnamed() {}
export async function healUnnamedNames() { return { healed: 0, pending: 0 }; }
