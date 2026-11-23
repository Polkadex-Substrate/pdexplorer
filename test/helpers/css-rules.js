// A small CSS reader for the colour guards (test/colour-roles.test.js): the
// innermost rules of a stylesheet as { line, selectors, decls, media }, and
// the :root custom properties. Comments are blanked, not removed, so line
// numbers stay true. No dependencies.

export function splitSelectors(head) {
    const out = []; let depth = 0, cur = '';
    for (const ch of head) {
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

export function parseRules(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const rules = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
        const head = m[1].trim();
        if (!head || head.startsWith('@')) continue;
        const before = clean.slice(0, m.index);
        const depth = before.split('{').length - before.split('}').length;
        const media = depth > 0 ? (before.match(/@[a-z-]+[^{]*\{(?![\s\S]*@[a-z-]+[^{]*\{)/) || [''])[0] : '';
        const decls = {};
        for (const d of m[2].split(';')) {
            const i = d.indexOf(':');
            if (i < 0) continue;
            decls[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
        }
        rules.push({ line: before.split('\n').length + (m[1].match(/^\s*/)[0].split('\n').length - 1), selectors: splitSelectors(head), decls, media });
    }
    return rules;
}

// The custom properties of the first :root block: { '--name': 'value' }, plus a count per name.
export function rootProps(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = clean.indexOf(':root');
    const body = clean.slice(clean.indexOf('{', start) + 1, clean.indexOf('}', start));
    const props = {}, counts = {};
    for (const d of body.split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        const name = d.slice(0, i).trim();
        if (!name.startsWith('--')) continue;
        props[name] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
        counts[name] = (counts[name] || 0) + 1;
    }
    return { props, counts, body };
}
