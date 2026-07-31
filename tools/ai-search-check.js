#!/usr/bin/env node
/**
 * AI Search planner check — run this locally to see how the planner interprets questions.
 *
 *   node tools/ai-search-check.js                     # run the built-in question set
 *   node tools/ai-search-check.js "your question"     # run one question
 *   node tools/ai-search-check.js --run               # also execute the queries against Zendesk
 *
 * Why this exists: the planner is a prompt, so the only way to know it behaves is to run it.
 * It reads the prompt-building code straight out of index.html rather than keeping its own
 * copy, so it can't drift away from what the app actually ships. If index.html is edited in a
 * way this can no longer parse, it fails loudly instead of testing something stale.
 *
 * It needs Node 18+ (for global fetch) and nothing else — no npm install.
 *
 * Credentials come from the same public Firestore doc the app reads, so there is nothing to
 * configure. Note that running this sends your question, your ticket IDs and the agent roster
 * to Google's Gemini API — the same thing the app does when you use the tab. With --run it
 * also queries Zendesk, but it never sends ticket contents anywhere.
 */

const fs = require('fs');
const path = require('path');

const FIRESTORE_DOC_URL = 'https://firestore.googleapis.com/v1/projects/routerpro-bbf42/databases/(default)/documents/routerpro/system_state_v11';
const INDEX_HTML = path.join(__dirname, '..', 'index.html');

// ---------------------------------------------------------------------------
// Pull the real prompt-building code out of index.html
// ---------------------------------------------------------------------------

function extractFunction(src, name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
    const m = re.exec(src);
    if (!m) throw new Error(`Could not find function ${name}() in index.html — this harness needs updating.`);
    const openParen = src.indexOf('(', m.index);
    let i = src.indexOf('{', openParen);
    if (i === -1) throw new Error(`Malformed function ${name}() in index.html`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
            depth--;
            if (depth === 0) return src.slice(m.index, j + 1);
        }
    }
    throw new Error(`Unbalanced braces while reading ${name}() from index.html`);
}

function extractConst(src, name) {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`);
    const m = re.exec(src);
    if (!m) throw new Error(`Could not find const ${name} in index.html — this harness needs updating.`);
    return `const ${name} = ${m[1]};`;
}

function loadAppCode() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!script) throw new Error('No inline <script> found in index.html');
    const src = script[1];

    const parts = [
        extractConst(src, 'AI_CHAT_HISTORY_LIMIT'),
        extractConst(src, 'AI_SEARCH_JIRA_FLAG_FIELD_ID'),
        extractConst(src, 'AI_SEARCH_ACCOUNT_FIELD_ID'),
        extractFunction(src, 'callGemini'),
        extractFunction(src, 'parseGeminiJson'),
        extractFunction(src, 'aiChatHistoryText'),
        extractFunction(src, 'aiAgentRosterText'),
        extractFunction(src, 'planAiChatTurn'),
    ];

    // eslint-disable-next-line no-new-func
    return new Function('State', 'aiChatHistory', 'aiSearchCache', `
        ${parts.join('\n\n')}
        return { planAiChatTurn, aiAgentRosterText, callGemini };
    `);
}

// ---------------------------------------------------------------------------
// Firestore / Zendesk helpers
// ---------------------------------------------------------------------------

function parseFirestoreValue(value) {
    if (value == null) return null;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return Number(value.doubleValue);
    if ('booleanValue' in value) return value.booleanValue;
    if ('nullValue' in value) return null;
    if ('mapValue' in value) {
        const out = {};
        const fields = (value.mapValue && value.mapValue.fields) || {};
        for (const key in fields) out[key] = parseFirestoreValue(fields[key]);
        return out;
    }
    if ('arrayValue' in value) {
        return ((value.arrayValue && value.arrayValue.values) || []).map(parseFirestoreValue);
    }
    return null;
}

async function loadState() {
    const res = await fetch(FIRESTORE_DOC_URL);
    if (!res.ok) throw new Error(`Firestore returned ${res.status}`);
    const doc = await res.json();
    const settings = parseFirestoreValue(doc.fields.settings) || {};
    const agents = parseFirestoreValue(doc.fields.agents) || [];
    if (!settings.ai || !settings.ai.apiKey) throw new Error('No AI API key in settings — set one in admin.html.');
    if (!settings.zendesk || !settings.zendesk.apiToken) throw new Error('Zendesk is not configured in settings.');
    return { settings, agents };
}

async function zendeskCount(zd, query) {
    const target = `https://${zd.subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(query)}`;
    const auth = Buffer.from(`${zd.email}/token:${zd.apiToken}`).toString('base64');
    const url = `${zd.proxyUrl.replace(/\/+$/, '')}?target=${encodeURIComponent(target)}`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return { error: res.status };
    const data = await res.json();
    return { count: data.count || 0 };
}

// ---------------------------------------------------------------------------
// Checks worth running automatically on whatever the planner returns
// ---------------------------------------------------------------------------

function lintPlan(plan, rosterEmails) {
    const problems = [];
    (plan.queries || []).forEach(q => {
        if (!/\btype:ticket\b/.test(q)) problems.push(`query is missing type:ticket -> ${q}`);

        // The bug this harness was written for: the planner inventing addresses. Any email it
        // puts behind assignee:/requester: must come from the roster, or it will match nothing.
        const emails = q.match(/\b(?:assignee|requester):(\S+@\S+)/g) || [];
        emails.forEach(frag => {
            const email = frag.split(':').slice(1).join(':').toLowerCase();
            if (!rosterEmails.has(email)) {
                problems.push(`email not in the agent roster (likely invented) -> ${email}`);
            }
        });
    });
    if (plan.action === 'search' && (!plan.queries || plan.queries.length === 0)) {
        problems.push('action is "search" but no queries were returned');
    }
    if (plan.countOnly && plan.listOnly) problems.push('countOnly and listOnly are both true');
    return problems;
}

const DEFAULT_CASES = [
    { q: 'how many onhold tickets are there with harsha agent', expect: 'resolves harsha to harsha.uppala@dispatchtrack.com' },
    { q: 'how many tickets got good reviews in last 3 days', expect: 'satisfaction:good + date, countOnly true' },
    { q: 'how many csats are received with comments in last 2 days', expect: 'satisfaction:good/bad + date, countOnly FALSE (comments are not searchable)' },
    { q: 'show me all open and on hold tickets from avineesh.goswami@lowes.com', expect: 'two queries, one per status, listOnly true' },
    { q: 'get me open tickets from the dsilowes customer in the last 2 months', expect: 'organization / account-slug / keyword attempts, NOT an invented email' },
    { q: 'what was the resolution on the order processing lag tickets?', expect: 'needsComments true' },
    { q: 'which of those could be closed?', expect: 'action reuse, needsComments true', cache: [{ id: 185142 }, { id: 185126 }] },
];

// ---------------------------------------------------------------------------

(async () => {
    const args = process.argv.slice(2);
    const runQueries = args.includes('--run');
    const questions = args.filter(a => !a.startsWith('--'));

    const app = loadAppCode();
    const { settings, agents } = await loadState();
    const State = { settings, agents };

    const rosterEmails = new Set(agents.filter(a => a.zendeskEmail).map(a => a.zendeskEmail.trim().toLowerCase()));
    console.log(`model: ${settings.ai.model || 'gemini-2.0-flash (default)'}`);
    console.log(`agents with a Zendesk email: ${rosterEmails.size} of ${agents.length}`);
    const missing = agents.filter(a => !a.zendeskEmail || !a.zendeskEmail.trim()).map(a => a.name);
    if (missing.length) console.log(`  (not searchable by assignee, no email set: ${missing.join(', ')})`);
    console.log('='.repeat(78));

    const cases = questions.length
        ? questions.map(q => ({ q }))
        : DEFAULT_CASES;

    let failures = 0;
    for (const c of cases) {
        const history = c.cache ? [{ role: 'user', text: 'previous lookup' }, { role: 'assistant', text: 'Found some tickets.' }] : [];
        const api = app(State, history, c.cache || []);

        console.log(`\nQ: ${c.q}`);
        if (c.expect) console.log(`   expected: ${c.expect}`);
        let plan;
        try {
            plan = await api.planAiChatTurn(c.q);
        } catch (err) {
            failures++;
            console.log(`   FAILED: ${err.message}`);
            continue;
        }
        console.log(`   action=${plan.action} countOnly=${plan.countOnly} listOnly=${plan.listOnly} needsComments=${plan.needsComments}`);
        (plan.queries || []).forEach(q => console.log(`   query: ${q}`));

        const problems = lintPlan(plan, rosterEmails);
        if (problems.length) {
            failures++;
            problems.forEach(p => console.log(`   !! ${p}`));
        } else {
            console.log('   checks: ok');
        }

        if (runQueries && plan.queries && plan.queries.length) {
            for (const q of plan.queries) {
                const r = await zendeskCount(settings.zendesk, q);
                const label = r.error ? `ERROR ${r.error}` : `${r.count} ticket(s)`;
                console.log(`   zendesk: ${label}  <-  ${q}`);
                if (!r.error && r.count === 0) console.log('            ^ matched nothing — check the filters in that query');
            }
        }
    }

    console.log('\n' + '='.repeat(78));
    console.log(failures === 0 ? 'All checks passed.' : `${failures} case(s) had problems — paste the output above to get them fixed.`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('\nHarness error:', err.message);
    process.exit(2);
});
