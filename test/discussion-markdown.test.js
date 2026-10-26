// Markdown in discussion posts (lib/discussion-markdown.js).
//
// The renderer is an XSS boundary on public pages, so besides "does each
// element render" these tests check the OUTPUT STRUCTURE of every result:
// only whitelisted tags, only whitelisted attributes, every attribute quoted
// and nothing left over after them (an attribute breakout leaves residue), every
// href on an allowed scheme, and tags properly nested. The same check runs over
// a seeded fuzz of hostile fragments, and the adversarial inputs are timed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown as md, safeUrl, MAX_RENDER_LEN } from '../lib/discussion-markdown.js';
import { renderPostHtml } from '../lib/discussion-edit.js';
import { escapeHtml } from '../lib/html-escape.js';

const TAGS = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'h3', 'h4', 'h5', 'ul', 'ol', 'li',
    'blockquote', 'hr', 'a', 'i', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div']);
const VOID = new Set(['br', 'hr']);
const ATTRS = {
    a: ['href', 'class', 'target', 'rel', 'title'],
    ol: ['start'], pre: ['class'], h3: ['class'], h4: ['class'], h5: ['class'], div: ['class'],
    i: ['class', 'aria-hidden'], th: ['style'], td: ['style']
};

// Throws with the offending tag if `html` is anything but whitelisted markup.
function assertSafe(html, src = '') {
    const ctx = `\n  input: ${JSON.stringify(src).slice(0, 300)}\n  output: ${html.slice(0, 600)}`;
    const stack = [];
    for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
        const [, close, name, rest] = m;
        const tag = name.toLowerCase();
        assert.ok(TAGS.has(tag), `tag <${tag}> is not whitelisted${ctx}`);
        if (close) {
            assert.equal(rest.trim(), '', `junk in a closing tag${ctx}`);
            assert.equal(stack.pop(), tag, `</${tag}> closes the wrong element${ctx}`);
            continue;
        }
        const allowed = ATTRS[tag] || [];
        const residue = rest.replace(/\s([a-z-]+)="([^"]*)"/g, (_, k, v) => {
            assert.ok(allowed.includes(k), `attribute ${k} on <${tag}>${ctx}`);
            if (k === 'href') assert.match(v, /^(https?:\/\/[^\s]|mailto:[^\s]|\/(?![\/\\]))/, `href ${v}${ctx}`);
            if (k === 'target') assert.equal(v, '_blank');
            if (k === 'rel') assert.equal(v, 'nofollow noopener noreferrer ugc');
            if (k === 'start') assert.match(v, /^\d+$/);
            if (k === 'style') assert.match(v, /^text-align:(left|right|center)$/);
            if (k === 'class') assert.match(v, /^[a-z -]+$/);
            if (k === 'aria-hidden') assert.equal(v, 'true');
            return '';
        });
        assert.equal(residue.trim(), '', `unparsed attribute text on <${tag}> (breakout?)${ctx}`);
        if (tag === 'a') {
            assert.ok(/ href="/.test(rest), `link without href${ctx}`);
            const ext = / target="_blank"/.test(rest);
            if (ext) assert.ok(/ rel="nofollow noopener noreferrer ugc"/.test(rest) && / title="Opens /.test(rest), `external link missing rel/title${ctx}`);
        }
        if (!VOID.has(tag)) stack.push(tag);
    }
    assert.deepEqual(stack, [], `unclosed tags${ctx}`);
    // No raw angle brackets outside tags, and no live event-handler text inside a tag.
    const text = html.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    assert.ok(!/[<>]/.test(text), `raw < or > in text${ctx}`);
    return html;
}
const r = (src, opts) => assertSafe(md(src, opts), src);
const links = html => [...html.matchAll(/<a href="([^"]*)"/g)].map(m => m[1]);

describe('block elements', () => {
    test('paragraphs and line breaks', () => {
        assert.equal(r('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
        assert.equal(r('a\r\nb'), '<p>a<br>b</p>');
        assert.equal(r(''), '');
        assert.equal(r('   \n\n  '), '');
        assert.equal(md(null), '');
    });
    test('headings render as h3-h5, never h1/h2', () => {
        assert.equal(r('# Big'), '<h3 class="md-h">Big</h3>');
        assert.equal(r('## Mid ##'), '<h4 class="md-h">Mid</h4>');
        for (const h of ['### a', '#### a', '##### a', '###### a']) assert.equal(r(h), '<h5 class="md-h">a</h5>');
        assert.equal(r('####### seven'), '<p>####### seven</p>');
        assert.equal(r('#hashtag'), '<p>#hashtag</p>');
        assert.equal(r('# **bold** title'), '<h3 class="md-h"><strong>bold</strong> title</h3>');
        assert.ok(!/<h[12]/.test(r('# a\n## b')));
    });
    test('bullet lists, one nesting level, + and * markers', () => {
        assert.equal(r('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
        assert.equal(r('* a\n+ b'), '<ul><li>a</li><li>b</li></ul>');
        assert.equal(r('- a\n  - a1\n  - a2\n- b'), '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
        // Deeper indentation stays at the one nested level.
        assert.equal(r('- a\n  - b\n      - c'), '<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>');
        assert.equal(r('- a\ncontinued'), '<ul><li>a<br>continued</li></ul>');
    });
    test('numbered lists keep their numbers', () => {
        assert.equal(r('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
        assert.equal(r('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
        assert.equal(r('1) a'), '<ol><li>a</li></ol>');
        assert.equal(r('1. a\n   - x\n2. b'), '<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>');
        // A different list type starts a new list.
        assert.equal(r('1. a\n- x\n2. b'), '<ol><li>a</li></ol><ul><li>x</li></ul><ol start="2"><li>b</li></ol>');
        // Items separated by blank lines stay one list.
        assert.equal(r('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
        assert.equal(r('1.5 PDEX'), '<p>1.5 PDEX</p>');
        assert.equal(r('-5 PDEX'), '<p>-5 PDEX</p>');
    });
    test('blockquotes, nested, depth capped at 3', () => {
        assert.equal(r('> a\n> b'), '<blockquote><p>a<br>b</p></blockquote>');
        assert.equal(r('> a\n>> b'), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>');
        const deep = r('>>>> four');
        assert.equal((deep.match(/<blockquote>/g) || []).length, 3);
        assert.ok(deep.includes('<p>&gt; four</p>'));
        assert.equal(r('> - item'), '<blockquote><ul><li>item</li></ul></blockquote>');
    });
    test('horizontal rules', () => {
        for (const hr of ['---', '***', '___', '- - -', ' * * * ']) assert.equal(r('a\n\n' + hr + '\n\nb'), '<p>a</p><hr><p>b</p>');
        assert.equal(r('a\n---'), '<p>a</p><hr>');
    });
    test('fenced code blocks are verbatim and escaped', () => {
        assert.equal(r('```\n**x** <b> [l](https://a.com)\n```'), '<pre class="md-code"><code>**x** &lt;b&gt; [l](https://a.com)</code></pre>');
        assert.equal(r('~~~js\nconst a = 1;\n~~~'), '<pre class="md-code"><code>const a = 1;</code></pre>');
        // Unclosed fence runs to the end; a shorter fence does not close a longer one.
        assert.equal(r('````\na\n```\nb'), '<pre class="md-code"><code>a\n```\nb</code></pre>');
        // The info string is never emitted.
        assert.ok(!r('```"><script>\nx\n```').includes('script>'));
    });
    test('simple tables, with alignment from a fixed set', () => {
        assert.equal(r('| a | b |\n|:--|--:|\n| 1 | **2** |'),
            '<div class="md-table-wrap"><table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead>'
            + '<tbody><tr><td style="text-align:left">1</td><td style="text-align:right"><strong>2</strong></td></tr></tbody></table></div>');
        assert.ok(r('a | b\n--- | ---\nc | d').includes('<td>c</td><td>d</td>'));
        assert.ok(r('a | b\n-|-\nx \\| y | z').includes('<td>x | y</td>'));
        // Not a table: column count mismatch, or no delimiter row.
        assert.ok(!r('a | b\n---').includes('<table'));
        assert.ok(!r('a | b\nc | d').includes('<table'));
    });
});

describe('inline elements', () => {
    test('bold, italic, strike, code', () => {
        assert.equal(r('**b** __b__ *i* _i_ ~~s~~ `c`'), '<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <del>s</del> <code>c</code></p>');
        assert.equal(r('~single~ ~~~triple~~~'), '<p>~single~ ~~~triple~~~</p>');
    });
    test('nested emphasis nests properly', () => {
        assert.equal(r('***x***'), '<p><em><strong>x</strong></em></p>');
        assert.equal(r('**a *b* c**'), '<p><strong>a <em>b</em> c</strong></p>');
        assert.equal(r('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
        assert.equal(r('~~**x**~~'), '<p><del><strong>x</strong></del></p>');
        // Crossed delimiters: the inner opener is dropped, output stays well-formed.
        r('*a **b* c**');
        r('**a *b** c*');
        r('_a *b_ c*');
    });
    test('intraword underscores and spaced stars stay literal', () => {
        assert.equal(r('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
        assert.equal(r('a * b'), '<p>a * b</p>');
    });
    test('backslash escapes', () => {
        assert.equal(r('\\*not\\* \\[x](y) \\`'), '<p>*not* [x](y) `</p>');
    });
    test('markdown inside code spans is not rendered', () => {
        assert.equal(r('`**x** [a](https://a.com) <b>`'), '<p><code>**x** [a](https://a.com) &lt;b&gt;</code></p>');
        assert.equal(r('`` a ` b ``'), '<p><code>a ` b</code></p>');
        assert.equal(r('`unclosed **b**'), '<p>`unclosed <strong>b</strong></p>');
    });
    test('code inside a link and emphasis', () => {
        assert.ok(r('[see `x` here](https://a.com)').includes('>see <code>x</code> here</a>'));
        assert.equal(r('**`x`**'), '<p><strong><code>x</code></strong></p>');
    });
    test('raw HTML is shown as text', () => {
        assert.equal(r('<b>hi</b> & <i>'), '<p>&lt;b&gt;hi&lt;/b&gt; &amp; &lt;i&gt;</p>');
    });
    test('control characters and placeholder characters cannot leak', () => {
        const out = r('a\u0000b\u0007c \uE0000\uE001 `x`');
        assert.ok(!/[\u0000-\u0008\uE000\uE001]/.test(out));
        assert.ok(out.includes('<code>x</code>'));
    });
});

describe('links', () => {
    const ext = 'class="md-link md-ext" target="_blank" rel="nofollow noopener noreferrer ugc"';
    test('external links open in a new tab and name their domain', () => {
        assert.equal(r('[docs](https://example.com/a?b=1&c=2)'),
            `<p><a href="https://example.com/a?b=1&amp;c=2" ${ext} title="Opens example.com in a new tab">docs</a></p>`);
        assert.equal(links(r('[x](http://Example.COM)'))[0], 'http://example.com/');
    });
    test('internal explorer links open in place (relative href, no target)', () => {
        assert.equal(r('[b](/blocks?x=1#y)'), '<p><a href="/blocks?x=1#y" class="md-link">b</a></p>');
        assert.equal(r('[a](https://explorer.polkadex.ee/account/abc)'), '<p><a href="/account/abc" class="md-link">a</a></p>');
        assert.equal(r('https://explorer.polkadex.ee/democracy'), '<p><a href="/democracy" class="md-link">https://explorer.polkadex.ee/democracy</a></p>');
        // Other hosts can be configured as internal.
        assert.equal(links(r('[t](https://test.example/x)', { internalHosts: ['test.example'] }))[0], '/x');
    });
    test('mailto links', () => {
        const h = r('[mail](mailto:team@example.com)');
        assert.ok(h.includes('href="mailto:team@example.com"') && h.includes('title="Email team@example.com"'));
        assert.ok(!h.includes('target='));
    });
    test('bare URLs are autolinked, minus trailing punctuation', () => {
        assert.deepEqual(links(r('see https://a.com/x, and (https://en.wikipedia.org/wiki/Foo_(bar)). End https://b.com.')),
            ['https://a.com/x', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://b.com/']);
        assert.deepEqual(links(r('**https://a.com**')), ['https://a.com/']);
        assert.deepEqual(links(r('xhttps://a.com')), []);
        assert.deepEqual(links(r('[https://a.com]')), ['https://a.com/']);
    });
    test('link text with nothing in it shows the URL', () => {
        assert.ok(r('[](https://a.com)').includes('>https://a.com</a>'));
    });
    test('balanced parentheses in a destination', () => {
        assert.deepEqual(links(r('[w](https://en.wikipedia.org/wiki/A_(b))')), ['https://en.wikipedia.org/wiki/A_(b)']);
    });
    test('a title is accepted and dropped: hover shows the real domain', () => {
        const h = r('[x](https://a.com "Click me")');
        assert.ok(h.includes('title="Opens a.com in a new tab"'));
        assert.ok(!h.includes('Click me'));
    });
    test('images render as a link, never an <img>', () => {
        const h = r('![a chart](https://a.com/c.png)');
        assert.ok(!h.includes('<img'));
        assert.ok(h.includes('href="https://a.com/c.png"') && h.includes('md-img-link') && h.includes('a chart</a>'));
        assert.ok(r('![](https://a.com/c.png)').includes('image</a>'));
    });
    test('long URLs are left whole (CSS wraps them)', () => {
        const u = 'https://a.com/' + 'x'.repeat(1500);
        assert.deepEqual(links(r(u)), [u]);
    });
});

describe('link-scheme attacks render as plain text', () => {
    const attacks = [
        '[x](javascript:alert(1))',
        '[x](JaVaScRiPt:alert(1))',
        '[x](&#106;avascript:alert(1))',
        '[x](&#x6A;avascript:alert(1))',
        '[x](%6Aavascript:alert(1))',
        '[x](java\tscript:alert(1))',
        '[x](java\nscript:alert(1))',
        '[x](java\u0000script:alert(1))',
        '[x]( javascript:alert(1))',
        '[x](\u0001javascript:alert(1))',
        '[x](\u200Bjavascript:alert(1))',
        '[x](vbscript:msgbox(1))',
        '[x](file:///etc/passwd)',
        '[x](data:text/html,<script>alert(1)</script>)',
        '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '[x](//evil.com)',
        '[x](/\\evil.com)',
        '[x](\\\\evil.com)',
        '[x](https:evil.com)',
        '[x](https:/\\evil.com)',
        '[x](/..//evil.com)',
        '[x](https://explorer.polkadex.ee@evil.com/)',
        '[x](https://user:pw@evil.com/)',
        '[x](mailto:javascript:alert(1))',
        '[x](relative/path)',
        '[x](#top)',
        '[x](<javascript:alert(1)>)',
        '![x](javascript:alert(1))',
        'javascript:alert(1)',
        '<javascript:alert(1)>',
        'https://explorer.polkadex.ee@evil.com/'
    ];
    for (const a of attacks) {
        test(JSON.stringify(a), () => {
            const h = r(a);
            assert.deepEqual(links(h), [], 'no link may be built');
            assert.ok(!/href=/.test(h));
        });
    }
    test('a bidi override cannot disguise a destination', () => {
        // The markdown link is refused; the bare-URL pass may link the honest
        // prefix before the override, which is exactly what the reader sees.
        for (const l of links(r('[x](https://evil.com/\u202Egnp.exe)'))) assert.equal(l, 'https://evil.com/');
        assert.equal(safeUrl('https://evil.com/\u202Egnp.exe'), null);
    });
    test('an explorer URL whose path is //host links absolute, never protocol-relative', () => {
        const h = r('[x](https://explorer.polkadex.ee//evil.com) https://explorer.polkadex.ee//evil.com');
        for (const l of links(h)) assert.ok(l.startsWith('https://explorer.polkadex.ee//'), l);
    });
    test('safeUrl', () => {
        assert.equal(safeUrl('javascript:alert(1)'), null);
        assert.equal(safeUrl('//evil.com'), null);
        assert.equal(safeUrl('/x').kind, 'internal');
        assert.equal(safeUrl('https://a.com').kind, 'external');
        assert.equal(safeUrl('mailto:a@b.co').kind, 'mail');
        assert.equal(safeUrl('https://a.com/' + 'x'.repeat(3000)), null);
    });
});

describe('HTML injection attempts', () => {
    const cases = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '"><svg/onload=alert(1)>',
        '<iframe src="https://evil.com"></iframe>',
        '<a href="javascript:alert(1)">x</a>',
        '[x](https://a.com/"onmouseover="alert(1))',
        '[x](https://a.com/\'onmouseover=\'alert(1))',
        '[x](https://a.com "a\\" onmouseover=\\"b")',
        '[x](https://a.com \'a" onmouseover="b\')',
        '[a"><script>alert(1)</script>](https://a.com)',
        '![x" onerror="alert(1)](https://a.com/i.png)',
        'https://a.com/"onmouseover=alert(1)//',
        'https://a.com/<script>alert(1)</script>',
        '`</code><script>alert(1)</script>`',
        '```\n</code></pre><script>alert(1)</script>\n```',
        '# <script>alert(1)</script>',
        '| <b> | x |\n|---|---|\n| <img src=x onerror=alert(1)> | y |',
        '> <svg onload=alert(1)>',
        '- <style>body{}</style>',
        '**<b>**',
        '[<img src=x>](https://a.com)'
    ];
    for (const c of cases) {
        test(JSON.stringify(c), () => {
            const h = r(c);
            // assertSafe (inside r) already proved every tag and attribute is whitelisted.
            assert.ok(!/<(script|img|svg|iframe|style|b)[\s>\/]/i.test(h), h);
            assert.ok(!/<[^>]*\son[a-z]+=/i.test(h), h);
        });
    }
    test('quotes in an accepted URL are escaped inside the attribute', () => {
        const h = r("[x](https://a.com/it's)");
        assert.ok(h.includes('href="https://a.com/it&#39;s"'), h);
    });
});

describe('existing plain-text posts still read well', () => {
    // Synthetic, in the style of the long production posts: a title line,
    // numbered sections, "- " bullets, plain lines in between.
    const POST = [
        'TREASURY PROPOSAL 99',
        'Funding request: (6 months), 100,000 PDEX; phase 2.',
        '',
        '1. What was delivered',
        '- Explorer: 40 fixes, new governance pages',
        '- Node: runtime upgrade prepared',
        '',
        'Each item above is in the public repositories.',
        '',
        '2. What comes next',
        '- Exchange relaunch',
        '- Wallet',
        '',
        '3. Costs',
        'Total: 100,000 PDEX, paid once.',
        'Questions welcome below.'
    ].join('\n');
    test('sections become numbered lists with their own numbers, bullets become lists', () => {
        const h = r(POST);
        assert.ok(h.startsWith('<p>TREASURY PROPOSAL 99<br>Funding request: (6 months), 100,000 PDEX; phase 2.</p>'));
        assert.ok(h.includes('<ol><li>What was delivered</li></ol><ul><li>Explorer: 40 fixes, new governance pages</li><li>Node: runtime upgrade prepared</li></ul>'));
        assert.ok(h.includes('<ol start="2"><li>What comes next</li></ol>'));
        assert.ok(h.includes('<ol start="3"><li>Costs<br>Total: 100,000 PDEX, paid once.<br>Questions welcome below.</li></ol>'));
    });
    test('no words are lost', () => {
        const text = md(POST).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
        for (const w of POST.replace(/^(\d+\.|-)\s/gm, '').split(/\s+/).filter(Boolean)) assert.ok(text.includes(w), w);
    });
    test('the long repeated-line post from the render test keeps its line breaks', () => {
        const LONG = 'POLKADEX TREASURY PROPOSAL 86\nCore team funding: (12 months), 1,234,567 PDEX; phase 1.\n'.repeat(60).slice(0, 4000);
        const h = r(LONG);
        assert.ok(h.startsWith('<p>POLKADEX TREASURY PROPOSAL 86<br>Core team funding: (12 months)'));
        assert.equal((h.match(/<p>/g) || []).length, 1);
    });
    test('a post body renders through the renderer', () => {
        const html = renderPostHtml({ id: 1, author: 'a', content: '**hi** [x](javascript:alert(1))', createdAt: 1 },
            { esc: escapeHtml, shortAddr: a => a, fmtDate: String, editable: false });
        assert.ok(html.includes('<div class="discussion-post-body md-body"><p><strong>hi</strong> [x](javascript:alert(1))</p></div>'));
    });
});

describe('no ReDoS: adversarial 4,000-character inputs render fast', () => {
    const N = 4000;
    const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    const inputs = {
        brackets: fill('['), closeBrackets: fill(']'), linkOpeners: fill('[a]('), parens: '[a](https://a.com/' + fill('('),
        bangs: fill('!['), stars: fill('*'), starWords: fill('*a'), underscores: fill('_a '), mixedDelims: fill('*_~'),
        tildes: fill('~~'), tripleStars: fill('***a'), backticks: fill('`'), backtickRuns: fill('` `` ``` '),
        quotes: fill('> '), quoteChars: fill('>'), bullets: fill('- '), nestedBullets: fill('  - x\n'), numbered: fill('1. '),
        hashes: fill('#'), heading: '#' + ' '.repeat(N - 2) + '#', headingHashes: '# ' + fill('# '), pipes: fill('|'),
        tableish: fill('|-\n'), autolinks: fill('http://'), longUrl: 'https://a.com/' + fill('a'), longLinkText: '[' + fill('x') + '](',
        backslashes: fill('\\'), newlines: fill('\n'), lines: fill('a\n'), fences: fill('```\n'), spaces: fill(' '),
        titles: fill('[a](b "'), entities: fill('&#106;'), emptyLinks: fill('[]()'), angle: fill('<a '),
        mixed: fill('**[`x`](https://a.com/_(*~~>|#- 1. ')
    };
    for (const [name, src] of Object.entries(inputs)) {
        test(name, () => {
            const t0 = process.hrtime.bigint();
            const out = md(src);
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            assertSafe(out, src);
            assert.ok(ms < 150, `${name}: ${ms.toFixed(1)} ms`);
        });
    }
    test('the whole set, and the 20,000-character render ceiling, stay well under a second', () => {
        const t0 = process.hrtime.bigint();
        for (const src of Object.values(inputs)) md(src);
        for (const src of Object.values(inputs)) md(src.repeat(5).slice(0, MAX_RENDER_LEN));
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 1500, `${ms.toFixed(1)} ms`);
    });
    test('beyond the ceiling the text is shown escaped, not parsed', () => {
        const h = md('**x** <b>\n'.repeat(3000));
        assert.ok(h.startsWith('<p>**x** &lt;b&gt;<br>'));
    });
});

describe('fuzz: hostile fragments in random order always give safe, well-formed HTML', () => {
    const parts = ['*', '**', '_', '__', '~~', '`', '```', '\n', '\n\n', '> ', '- ', '1. ', '  - ', '# ', '---', '|', '|-|', '[', ']', '(', ')',
        '![', '](', 'https://a.com', 'https://explorer.polkadex.ee/x', '//evil.com', 'javascript:alert(1)', '"', "'", '<', '>', '&', '\\',
        '<script>', 'onerror=', 'text', ' ', 'mailto:a@b.co', '/blocks', '\t', '\u202E', '#'];
    let seed = 20261026;
    const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    test('3,000 random posts', () => {
        for (let k = 0; k < 3000; k++) {
            let s = '';
            const len = 1 + rand(40);
            for (let j = 0; j < len; j++) s += parts[rand(parts.length)];
            assertSafe(md(s), s);
        }
    });
});
