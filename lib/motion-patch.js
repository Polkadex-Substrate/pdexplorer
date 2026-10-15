// In-place updates of the open motion cards on the Council page (Checker L8).
// renderCollectiveMotions in script.js builds each card from parts (badge,
// tally bars, meta line, voter lists, actions) and asks motionPatchPlan
// (lib/tx-status.js) whether a re-render can patch them; this applies the plan.
// A live vote then changes one card's bars and voter list instead of redrawing
// the section, which reset scroll, focus and hover on every block.

// A stable id per REST snapshot object, for the render frame: a poll brings a
// new object (full render), a live update keeps the same one (patch).
const ids = new WeakMap();
let seq = 0;
export function motionDataId(d) {
    if (!d || typeof d !== 'object') return 0;
    if (!ids.has(d)) ids.set(d, ++seq);
    return ids.get(d);
}

// Replace only the listed parts of the listed cards, then rewire(cardEl) for a
// card whose actions changed. Returns false, touching nothing, when the DOM is
// not what the plan expects; the caller then renders the whole section.
export function patchMotionCards(root, changed, cardModels, rewire) {
    const cardEls = new Map(Array.from(root.querySelectorAll('.motion-card[data-hash]')).map(el => [el.getAttribute('data-hash'), el]));
    if (cardEls.size !== cardModels.length) return false;
    const byHash = new Map(cardModels.map(c => [c.hash, c]));
    const work = [];
    for (const ch of changed) {
        const el = cardEls.get(ch.hash), model = byHash.get(ch.hash);
        if (!el || !model) return false;
        for (const part of ch.parts) {
            const slot = el.querySelector(`[data-part="${part}"]`);
            if (!slot) return false;
            work.push([slot, model.parts[part]]);
        }
    }
    for (const [slot, html] of work) slot.innerHTML = html;
    for (const ch of changed) if (ch.parts.includes('actions') && typeof rewire === 'function') rewire(cardEls.get(ch.hash));
    return true;
}
