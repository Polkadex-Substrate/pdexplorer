// Governance status vocabulary, shared by every consumer.
//
// Audit F-003: the democracy indexer writes polkadot-js enum names
// ('Ongoing', 'Passed', 'NotPassed') while the notification banner, the
// calendar's active set, and the email dispatcher each compared against
// lowercase 'ongoing' / 'started'. The result: no referendum ever counted as
// open in those three places, so voters were never told a referendum had
// opened or was about to close — silently, for every referendum.
//
// The lesson is not "fix the casing" but "stop having four independent
// spellings of the same concept". One predicate, imported everywhere, so the
// indexer's output and the consumers' comparison cannot drift again.

export function isOpenGovStatus(status) {
    const s = String(status == null ? '' : status).toLowerCase();
    return s === 'ongoing' || s === 'started';
}
