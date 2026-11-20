export const PROXIED_STASHES_ROUTE = '/api/proxied-stashes/:address';
export const MAX_CANDIDATES = 16;
export const PROXY_EVENT_LIMIT = 200;
export const PROXIED_TTL_MS = 60_000;
export function proxyCandidates() { return []; }
export async function readProxiedStashes() { return []; }
export function registerProxiedStashesRoute() {}
export function proxiedStashesHtml() { return ''; }
