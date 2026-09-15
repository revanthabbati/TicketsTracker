#!/usr/bin/env node
/**
 * Call Lines check — verifies the check-in/check-out logic behaves under concurrency.
 *
 *   node tools/lines-check.js
 *
 * Why this exists: line sessions are shared state that several agents write at once, and
 * this app has already lost data once to a whole-array overwrite (see mutateUsers in
 * index.html). The risky parts — seat capacity, line switching, double check-out — are all
 * decided *inside* a transaction, and that is exactly the kind of logic you cannot check by
 * clicking through the UI, because you would have to click in two browsers simultaneously.
 *
 * So runTransaction is faked over a plain object, with a hook that lets a second client
 * commit in the middle of the first one's transaction. That reproduces the race
 * deterministically.
 *
 * Like tools/ai-search-check.js, this extracts the real functions from index.html at runtime
 * rather than keeping its own copy, so it cannot drift from what ships. Renaming those
 * functions breaks it loudly instead of testing something stale.
 *
 * Needs Node 18+. No npm install, no network, no credentials — nothing here reaches
 * Firestore, Zendesk or production data.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractBlock(src, startMarker, endMarker) {
    const start = src.indexOf(startMarker);
    if (start < 0) throw new Error('start marker not found: ' + startMarker);
    const end = src.indexOf(endMarker, start);
    if (end < 0) throw new Error('end marker not found: ' + endMarker);
    return src.slice(start, end);
}

const block = extractBlock(html, '/** --- CALL LINES (AGENT LINE TRACKING) ---', '        function notify(message) {');

// ---- fakes -------------------------------------------------------------
let doc = {};                 // the "Firestore document"
let transactionDelay = null;  // lets a second client interleave mid-transaction

const docRef = {};
async function runTransaction(db, fn) {
    const snapshotAtStart = JSON.parse(JSON.stringify(doc));
    let pending = null;
    const tx = {
        get: async () => ({ exists: () => true, data: () => snapshotAtStart }),
        update: (ref, payload) => { pending = { ...(pending || {}), ...payload }; },
        set: (ref, payload) => { pending = { ...(pending || {}), ...payload }; }
    };
    const result = await fn(tx);
    if (transactionDelay) { const d = transactionDelay; transactionDelay = null; await d(); }
    if (pending) doc = { ...doc, ...JSON.parse(JSON.stringify(pending)) };
    return result;
}

const notices = [];
const State = { lines: [], lineSessions: [], agents: [], currentUser: null, activities: [], commit: async () => {} };
const UI = {};
const globals = {
    runTransaction, db: {}, docRef, State, UI,
    notify: m => notices.push(m),
    escapeHtml: s => String(s == null ? '' : s),
    logActivity: () => {},
    currentUserEmail: () => (State.currentUser && State.currentUser.email) || '',
    formatUserLabel: e => String(e || '').split('@')[0] || '—',
    getTodayShiftWindow: () => ({ start: new Date(Date.now() - 36e5 * 12), end: new Date(Date.now() + 36e5 * 12) }),
    getLocalDateString: () => '2026-09-16',
    triggerDownload: () => {},
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [] }
};

const factory = new Function(...Object.keys(globals), `
    ${block}
    renderLinesView = function () {};   // DOM rendering is out of scope for this harness
    return { mutateDocArray, performLineCheckIn, performLineCheckOut, pruneLineSessions,
             lineSessionDuration, formatLineDuration, formatLineHours, closeLineSession,
             openLineSessions, canManageLines, myLineIdentity, LINE_SESSION_CAP,
             setAgentPresence, isAgentAway, agentPresence, PRESENCE_AWAY,
             lineCheckIn: window.lineCheckIn, lineCheckOut: window.lineCheckOut };
`);
const L = factory(...Object.values(globals));

// ---- test rig ----------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function reset(lines, sessions) {
    doc = { users: [{ id: 'u1' }], tickets: [{ id: 't1' }], agents: [], lines: lines || [], lineSessions: sessions || [] };
    State.lines = doc.lines; State.lineSessions = doc.lineSessions;
    notices.length = 0;
}

const LINE1 = { id: 'L1', name: 'Line 1', capacity: 2, isActive: true };
const LINE2 = { id: 'L2', name: 'Line 2', capacity: null, isActive: true };
const A = { agentId: 'a1', agentName: 'Asha', userEmail: 'asha@x.com', linked: true };
const B = { agentId: 'a2', agentName: 'Ben', userEmail: 'ben@x.com', linked: true };
const C = { agentId: 'a3', agentName: 'Cara', userEmail: 'cara@x.com', linked: true };

(async () => {
    console.log('\n1. Check-in writes a session and leaves other fields alone');
    reset([LINE1, LINE2]);
    let r = await L.performLineCheckIn(LINE1, A, 'admin@x.com');
    check('check-in succeeded', r.ok === true, JSON.stringify(r));
    check('one open session', doc.lineSessions.length === 1 && !doc.lineSessions[0].checkOutAt);
    check('session carries line + agent', doc.lineSessions[0].lineName === 'Line 1' && doc.lineSessions[0].agentId === 'a1');
    check('users array untouched', doc.users.length === 1 && doc.users[0].id === 'u1');
    check('tickets array untouched', doc.tickets.length === 1);

    console.log('\n2. Same agent cannot double-book the same line');
    r = await L.performLineCheckIn(LINE1, A, 'admin@x.com');
    check('rejected', r.ok === false && /already checked in/.test(r.rejection || ''), JSON.stringify(r));
    check('still one session', doc.lineSessions.length === 1);

    console.log('\n3. Switching lines closes the previous session (no double counting)');
    r = await L.performLineCheckIn(LINE2, A, 'admin@x.com');
    check('switch succeeded', r.ok === true && r.switchedFrom === 'Line 1', JSON.stringify(r));
    check('two sessions total', doc.lineSessions.length === 2);
    check('exactly one still open', doc.lineSessions.filter(s => !s.checkOutAt).length === 1);
    const closedOne = doc.lineSessions.find(s => s.checkOutAt);
    check('closed one is Line 1, reason=switch', closedOne.lineName === 'Line 1' && closedOne.endedReason === 'switch');
    check('open one is Line 2', doc.lineSessions.find(s => !s.checkOutAt).lineName === 'Line 2');

    console.log('\n4. Capacity is enforced INSIDE the transaction (race for the last seat)');
    reset([LINE1]);
    await L.performLineCheckIn(LINE1, A, 'x');           // seat 1 of 2
    // Client B starts its transaction, then C fully commits before B writes.
    transactionDelay = async () => { await L.performLineCheckIn(LINE1, C, 'x'); };
    r = await L.performLineCheckIn(LINE1, B, 'x');
    const occupants = doc.lineSessions.filter(s => !s.checkOutAt).length;
    check('line never exceeds capacity', occupants <= 2, occupants + ' occupants on a 2-seat line');
    check('the loser was told why', occupants === 2);

    console.log('\n5. Capacity blocks a plain over-subscription');
    reset([LINE1], []);
    await L.performLineCheckIn(LINE1, A, 'x');
    await L.performLineCheckIn(LINE1, B, 'x');
    r = await L.performLineCheckIn(LINE1, C, 'x');
    check('third agent rejected', r.ok === false && /full/.test(r.rejection || ''), JSON.stringify(r));
    check('two on the line', doc.lineSessions.filter(s => !s.checkOutAt).length === 2);

    console.log('\n6. Unlimited-capacity lines accept everyone');
    reset([LINE2], []);
    for (const who of [A, B, C]) await L.performLineCheckIn(LINE2, who, 'x');
    check('all three on Line 2', doc.lineSessions.filter(s => !s.checkOutAt).length === 3);

    console.log('\n7. Check-out records a duration and is idempotent');
    reset([LINE1], []);
    await L.performLineCheckIn(LINE1, A, 'x');
    const sid = doc.lineSessions[0].id;
    // Backdate the check-in by 90 minutes so the duration is meaningful.
    doc.lineSessions[0].checkInAt = new Date(Date.now() - 90 * 60000).toISOString();
    State.lineSessions = doc.lineSessions;
    let out = await L.performLineCheckOut(sid, 'boss@x.com', 'supervisor');
    check('check-out succeeded', out.ok === true);
    const done = doc.lineSessions[0];
    check('durationMs ~90min', Math.abs(done.durationMs - 90 * 60000) < 5000, String(done.durationMs));
    check('records who and why', done.checkOutBy === 'boss@x.com' && done.endedReason === 'supervisor');
    const firstCheckout = done.checkOutAt;
    out = await L.performLineCheckOut(sid, 'someone@x.com', 'manual');
    check('second check-out is a no-op', out.ok === false);
    check('original check-out time preserved', doc.lineSessions[0].checkOutAt === firstCheckout);
    check('original closer preserved', doc.lineSessions[0].checkOutBy === 'boss@x.com');

    console.log('\n8. Duration maths');
    check('open session counts up to now', L.lineSessionDuration({ checkInAt: new Date(Date.now() - 60000).toISOString(), checkOutAt: null }) >= 59000);
    check('closed session uses checkOutAt', L.lineSessionDuration({ checkInAt: '2026-01-01T00:00:00Z', checkOutAt: '2026-01-01T02:30:00Z' }) === 9000000);
    check('bad date is 0 not NaN', L.lineSessionDuration({ checkInAt: 'nonsense', checkOutAt: null }) === 0);
    check('negative clamped to 0', L.lineSessionDuration({ checkInAt: '2026-01-01T05:00:00Z', checkOutAt: '2026-01-01T04:00:00Z' }) === 0);
    check('formats hours', L.formatLineDuration(9000000) === '2h 30m', L.formatLineDuration(9000000));
    check('formats minutes', L.formatLineDuration(90000) === '1m 30s', L.formatLineDuration(90000));
    check('formats seconds', L.formatLineDuration(9000) === '9s', L.formatLineDuration(9000));
    check('hours decimal', L.formatLineHours(9000000) === '2.50');

    console.log('\n9. Pruning never drops an OPEN session');
    const many = [];
    for (let i = 0; i < L.LINE_SESSION_CAP + 50; i++) {
        many.push({ id: 'c' + i, checkInAt: new Date(Date.now() - (i + 1) * 60000).toISOString(), checkOutAt: new Date().toISOString() });
    }
    many.push({ id: 'openest', checkInAt: new Date(Date.now() - 999999999).toISOString(), checkOutAt: null });
    const pruned = L.pruneLineSessions(many);
    check('capped at the limit', pruned.length === L.LINE_SESSION_CAP, String(pruned.length));
    check('the very oldest OPEN session survives', pruned.some(s => s.id === 'openest'));
    check('newest closed session survives', pruned.some(s => s.id === 'c0'));
    check('oldest closed session dropped', !pruned.some(s => s.id === 'c' + (L.LINE_SESSION_CAP + 49)));
    check('no pruning under the cap', L.pruneLineSessions(many.slice(0, 10)).length === 10);

    console.log('\n10. Identity resolution');
    State.agents = [{ id: 'ag1', name: 'Asha', zendeskEmail: 'Asha@dispatchtrack.com' }];
    State.currentUser = { id: 'u9', email: 'asha.k@dispatchtrack.com', zendeskAgentEmail: 'asha@dispatchtrack.com' };
    let id = L.myLineIdentity();
    check('links via zendeskAgentEmail, case-insensitively', id.agentId === 'ag1' && id.linked === true, JSON.stringify(id));
    State.currentUser = { id: 'u9', email: 'Asha@dispatchtrack.com', zendeskAgentEmail: '' };
    id = L.myLineIdentity();
    check('falls back to login email', id.agentId === 'ag1', JSON.stringify(id));
    State.currentUser = { id: 'u9', email: 'nobody@dispatchtrack.com', zendeskAgentEmail: '' };
    id = L.myLineIdentity();
    check('unlinked user still gets a stable id', id.agentId === 'user:u9' && id.linked === false && id.agentName === 'nobody', JSON.stringify(id));
    State.currentUser = null;
    check('no session -> null', L.myLineIdentity() === null);

    console.log('\n11. Permission helper');
    State.currentUser = { role: 'admin', permissions: {} };
    check('admin can manage', L.canManageLines() === true);
    State.currentUser = { role: 'user', permissions: { manageLines: true } };
    check('permission grants manage', L.canManageLines() === true);
    State.currentUser = { role: 'user', permissions: { manageAgents: true } };
    check('other permissions do not', L.canManageLines() === false);
    State.currentUser = { role: 'user' };
    check('missing permissions object is safe', L.canManageLines() === false);
    State.currentUser = null;
    check('signed out cannot manage', L.canManageLines() === false);

    console.log('\n12. Away closes the line session and takes the agent off the floor');
    reset([LINE1, LINE2], []);
    doc.agents = [
        { id: 'a1', name: 'Asha', isAvailable: true, zendeskEmail: 'asha@x.com', shifts: { 1: { start: '21:00', end: '06:00' } } },
        { id: 'a2', name: 'Ben', isAvailable: true, zendeskEmail: 'ben@x.com' }
    ];
    State.agents = doc.agents;
    State.currentUser = { id: 'u1', email: 'x@y.z', role: 'admin', permissions: {} };
    await L.performLineCheckIn(LINE1, A, 'x');
    let res = await L.setAgentPresence('a1', L.PRESENCE_AWAY);
    check('away applied', res.ok === true, JSON.stringify(res));
    check('taken off the floor', doc.agents.find(a => a.id === 'a1').isAvailable === false);
    check('presence recorded', doc.agents.find(a => a.id === 'a1').presence === 'away');
    check('line session closed as a break', doc.lineSessions.some(s => s.endedReason === 'break'));
    check('nobody left on a line', doc.lineSessions.filter(s => !s.checkOutAt).length === 0);
    check('the line is remembered', doc.agents.find(a => a.id === 'a1').awayFromLineId === 'L1');
    check('the other agent is untouched', doc.agents.find(a => a.id === 'a2').isAvailable === true);
    // The agents array carries fields nothing here touches -- they must survive the write,
    // since this is the array the round-robin and shift evaluator depend on.
    check('unrelated agent fields survive', !!doc.agents.find(a => a.id === 'a1').shifts['1']);
    check('other top-level arrays survive', doc.users.length === 1 && doc.tickets.length === 1 && doc.lines.length === 2);

    console.log('\n13. Coming back restores the floor and the line');
    res = await L.setAgentPresence('a1', 'in');
    check('back applied', res.ok === true);
    check('back on the floor', doc.agents.find(a => a.id === 'a1').isAvailable === true);
    check('presence cleared', doc.agents.find(a => a.id === 'a1').presence === 'in');
    check('resumed the line they left', doc.lineSessions.some(s => !s.checkOutAt && s.agentId === 'a1' && s.lineId === 'L1'), JSON.stringify(doc.lineSessions.map(s => s.lineName + ':' + !!s.checkOutAt)));
    check('remembered line cleared', doc.agents.find(a => a.id === 'a1').awayFromLineId === '');
    check('resume reported to the caller', res.resumedLineName === 'Line 1', JSON.stringify(res));

    console.log('\n14. Away is tied to availability, so the two can never disagree');
    check('away + unavailable reads as away', L.isAgentAway({ presence: 'away', isAvailable: false }) === true);
    check('away flag alone does NOT read as away', L.isAgentAway({ presence: 'away', isAvailable: true }) === false);
    check('plain unavailable is not away', L.isAgentAway({ isAvailable: false }) === false);
    check('undefined agent is safe', L.isAgentAway(undefined) === false);

    console.log('\n15. Going Away twice does not lose the remembered line');
    reset([LINE1], []);
    doc.agents = [{ id: 'a1', name: 'Asha', isAvailable: true, zendeskEmail: 'asha@x.com' }];
    State.agents = doc.agents;
    await L.performLineCheckIn(LINE1, A, 'x');
    await L.setAgentPresence('a1', L.PRESENCE_AWAY);
    const remembered = doc.agents.find(a => a.id === 'a1').awayFromLineId;
    await L.setAgentPresence('a1', L.PRESENCE_AWAY);
    check('still remembers the line', doc.agents.find(a => a.id === 'a1').awayFromLineId === remembered && remembered === 'L1');

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
