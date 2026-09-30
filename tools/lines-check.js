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
const State = { lines: [], lineSessions: [], lineSettings: {}, lineRoster: {}, agents: [], currentUser: null, activities: [], commit: async () => {} };
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
             dashboardLineCount, dashboardLines, canViewLineReports, mutateDocObject,
             autoAssignRoster, rosterSlotHours, parseRosterCsv, matchAgentByName,
             rosterLoadTotals, rosterData, DEFAULT_ROSTER_SLOTS, ROSTER_DAYS,
             moveLine: window.moveLine,
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

    console.log('\n16. The Dashboard shows the first N lines IN ORDER');
    // Regression: an earlier build picked lines by matching the names "Line 1/2/3", so a line
    // called "Line 2 / Opsmon" dropped out of the set and the cards rendered out of order.
    const MANY = [
        { id: 'L1', name: 'Line 1', order: 0, isActive: true },
        { id: 'L2', name: 'Line 2 / Opsmon', order: 1, isActive: true },
        { id: 'L3', name: 'Line 3', order: 2, isActive: true },
        { id: 'L4', name: 'Line 4', order: 3, isActive: true },
        { id: 'L5', name: 'Line 5', order: 4, isActive: true }
    ];
    reset(MANY, []);
    State.lineSettings = {};
    check('defaults to 3', L.dashboardLineCount() === 3, String(L.dashboardLineCount()));
    check('takes the first three in order, odd names included',
        L.dashboardLines().map(l => l.name).join(' | ') === 'Line 1 | Line 2 / Opsmon | Line 3',
        L.dashboardLines().map(l => l.name).join(' | '));
    State.lineSettings = { dashboardCount: 5 };
    check('honours the admin setting', L.dashboardLines().length === 5);
    State.lineSettings = { dashboardCount: 99 };
    check('a count past the end just shows them all', L.dashboardLines().length === 5);
    State.lineSettings = { dashboardCount: 0 };
    check('zero falls back to the default', L.dashboardLineCount() === 3);
    State.lineSettings = { dashboardCount: 'nonsense' };
    check('garbage falls back to the default', L.dashboardLineCount() === 3);
    State.lineSettings = {};

    console.log('\n17. Reordering lines changes what the Dashboard shows');
    State.currentUser = { role: 'admin', permissions: {} };
    await L.moveLine('L3', 'up');
    check('Line 3 moved above Line 2 / Opsmon',
        L.dashboardLines().map(l => l.name).join(' | ') === 'Line 1 | Line 3 | Line 2 / Opsmon',
        L.dashboardLines().map(l => l.name).join(' | '));
    check('order renumbered cleanly', doc.lines.map(l => l.order).sort((a, b) => a - b).join(',') === '0,1,2,3,4');
    await L.moveLine('L1', 'up');
    check('moving the first line up does nothing', L.dashboardLines()[0].name === 'Line 1');
    const last = doc.lines.slice().sort((a, b) => a.order - b.order).pop();
    await L.moveLine(last.id, 'down');
    check('moving the last line down does nothing', doc.lines.slice().sort((a, b) => a.order - b.order).pop().id === last.id);
    // Older records can have a missing or duplicated `order`; the swap must still work.
    doc.lines.forEach(l => { delete l.order; });
    State.lines = doc.lines;
    const beforeNames = L.dashboardLines().map(l => l.name);
    await L.moveLine(beforeNames[2] === 'Line 3' ? 'L3' : doc.lines[2].id, 'up');
    check('survives records with no order field', doc.lines.every(l => Number.isFinite(l.order)));

    console.log('\n18. Call line reports are permission-gated');
    State.currentUser = { role: 'admin', permissions: {} };
    check('admin can view', L.canViewLineReports() === true);
    State.currentUser = { role: 'user', permissions: { viewLineReports: true } };
    check('the report permission grants it', L.canViewLineReports() === true);
    State.currentUser = { role: 'user', permissions: { manageLines: true } };
    check('managing lines implies viewing reports', L.canViewLineReports() === true);
    State.currentUser = { role: 'user', permissions: { manageAgents: true, viewCsat: true } };
    check('unrelated permissions do NOT grant it', L.canViewLineReports() === false);
    State.currentUser = { role: 'user', permissions: {} };
    check('a plain user cannot view', L.canViewLineReports() === false);
    State.currentUser = { role: 'user' };
    check('a missing permissions object is safe', L.canViewLineReports() === false);
    State.currentUser = null;
    check('signed out cannot view', L.canViewLineReports() === false);


    console.log('\n19. Roster slot hours, including slots that cross midnight');
    check('a normal slot', L.rosterSlotHours({ start: '21:00', end: '23:00' }) === 2);
    check('a slot crossing midnight', L.rosterSlotHours({ start: '23:00', end: '01:00' }) === 2);
    check('the short last slot', L.rosterSlotHours({ start: '05:00', end: '06:00' }) === 1);
    check('the seeded shift totals 9h (matches the team sheet)',
        L.DEFAULT_ROSTER_SLOTS.reduce((s, x) => s + L.rosterSlotHours(x), 0) === 9);

    console.log('\n20. Auto-assign never double-books anybody in one slot');
    const RLINES = [
        { id: 'L1', name: 'Line 1', order: 0, isActive: true },
        { id: 'L2', name: 'Line 2', order: 1, isActive: true },
        { id: 'L3', name: 'Line 3', order: 2, isActive: true }
    ];
    const ROSTER_AGENTS = ['Ram', 'Srinath', 'Akash', 'Rahul', 'Ganesh', 'Ashok', 'Tarun', 'Krishna']
        .map((n, i) => ({ id: 'r' + i, name: n, role: 'support', isAvailable: true, zendeskEmail: n.toLowerCase() + '@x.com' }));
    reset(RLINES, []);
    State.agents = ROSTER_AGENTS;
    State.lineRoster = {};
    State.currentUser = { role: 'admin', permissions: {} };

    let auto = L.autoAssignRoster({ scope: 'week', mode: 'replace', pool: 'support', day: 1 });
    check('a grid came back', !!auto.grid, JSON.stringify(auto.reason));
    const slotIds = L.DEFAULT_ROSTER_SLOTS.map(s => s.id);
    let duplicateSlots = 0, cells = 0;
    Object.keys(auto.grid).forEach(d => slotIds.forEach(sid => {
        const vals = Object.values(auto.grid[d][sid] || {}).filter(Boolean);
        cells += vals.length;
        if (new Set(vals).size !== vals.length) duplicateSlots++;
    }));
    check('every day/slot/line cell filled (7x5x3)', cells === 105, String(cells));
    check('nobody holds two lines in the same slot', duplicateSlots === 0, duplicateSlots + ' clashing slots');

    console.log('\n21. Auto-assign spreads the hours fairly');
    State.lineRoster = { slots: L.DEFAULT_ROSTER_SLOTS, grid: auto.grid };
    let load = [...L.rosterLoadTotals().values()].map(r => r.hours).sort((a, b) => a - b);
    check('everyone was used', load.length === 8, String(load.length));
    check('busiest and quietest differ by at most 1h', load[load.length - 1] - load[0] <= 1, load.join(','));
    // Deterministic: the same inputs must give the same rota, or "regenerate" would reshuffle
    // people's shifts for no reason every time someone pressed the button.
    State.lineRoster = {};
    const again = L.autoAssignRoster({ scope: 'week', mode: 'replace', pool: 'support', day: 1 });
    check('the same inputs give the same rota', JSON.stringify(again.grid) === JSON.stringify(auto.grid));

    console.log('\n22. Auto-assign leaves slots empty rather than double-booking a small team');
    State.agents = ROSTER_AGENTS.slice(0, 2);   // 2 people, 3 lines
    State.lineRoster = {};
    const thin = L.autoAssignRoster({ scope: 'day', mode: 'replace', pool: 'support', day: 1 });
    const mondaySlot = thin.grid['1'][slotIds[0]];
    check('only as many lines as people are filled', Object.keys(mondaySlot).length === 2, JSON.stringify(mondaySlot));
    check('and those two are different people', new Set(Object.values(mondaySlot)).size === 2);
    State.agents = ROSTER_AGENTS;

    console.log('\n23. Fill-gaps mode leaves existing assignments alone');
    State.lineRoster = { slots: L.DEFAULT_ROSTER_SLOTS, grid: JSON.parse(JSON.stringify(auto.grid)) };
    delete State.lineRoster.grid['1'][slotIds[0]].L1;
    delete State.lineRoster.grid['3'][slotIds[2]].L3;
    const filled = L.autoAssignRoster({ scope: 'week', mode: 'fill', pool: 'support', day: 1 });
    let touched = 0, gapsClosed = 0;
    Object.keys(auto.grid).forEach(d => slotIds.forEach(sid => ['L1', 'L2', 'L3'].forEach(l => {
        const before = (State.lineRoster.grid[d][sid] || {})[l] || '';
        const after = (filled.grid[d][sid] || {})[l] || '';
        if (before && after !== before) touched++;
        if (!before && after) gapsClosed++;
    })));
    check('no existing assignment was changed', touched === 0, String(touched));
    check('both gaps were filled', gapsClosed === 2, String(gapsClosed));

    console.log('\n24. Importing the team spreadsheet');
    State.lineRoster = { slots: L.DEFAULT_ROSTER_SLOTS, grid: {} };
    const SHEET = [
        ',Monday,,,,',
        'Hours,hours,Line 1,Line 2,Line 3,',
        '9 to 11,2,Ram,Srinath,Akash,',
        '11 to 1,2,Rahul,Ganesh,Ashok,',
        '1 to 3,2,Srinath,Ram,Tarun,',
        '3 to 5,2,Akash,Krishna,Ganesh,',
        '5 to 6,1,Ram,Srinath,Rahul,',
        ',,,,,',
        ' ,Tuesday,,,,Exception',
        'Hours,hours,Line 1,Line 2,Line 3,',
        '9 to 11,2,Ram,Tarun,Rahul,',
        '3 to 5,2,Krishna,Ashok,Rhul,'
    ].join('\r\n');
    const imported = L.parseRosterCsv(SHEET);
    check('Monday and Tuesday were read', imported.days === 2, String(imported.days));
    check('Monday row 1 is Ram | Srinath | Akash',
        ['L1', 'L2', 'L3'].map(l => imported.grid['1'][slotIds[0]][l]).join(',') === 'r0,r1,r2',
        JSON.stringify(imported.grid['1'][slotIds[0]]));
    check('the day header row is not read as a slot', !imported.grid['1']['Hours']);
    // "Rhul" is a real typo in the team's own sheet. It must be reported, not silently dropped.
    check('an unmatched name is reported', imported.unmatched.has('Rhul'), JSON.stringify([...imported.unmatched.keys()]));
    check('and that cell is left empty', !imported.grid['2'][slotIds[3]].L3);
    check('the rest of that row still imported', imported.grid['2'][slotIds[3]].L1 === 'r7');
    // Monday 5 rows x 3 lines = 15, Tuesday 2 rows x 3 lines = 6 less the "Rhul" typo = 5.
    // The trailing "Exception" column matches no line name, so it must not add a 21st.
    check('the stray Exception column adds nothing', imported.assigned === 20, String(imported.assigned));

    console.log('\n25. Importing only touches the days present in the file');
    State.lineRoster = { slots: L.DEFAULT_ROSTER_SLOTS, grid: JSON.parse(JSON.stringify(auto.grid)) };
    const weekendBefore = JSON.stringify(State.lineRoster.grid['6']);
    const partial = L.parseRosterCsv(SHEET);
    Object.keys(partial.grid).forEach(d => { State.lineRoster.grid[d] = partial.grid[d]; });
    check('Saturday was left exactly as it was', JSON.stringify(State.lineRoster.grid['6']) === weekendBefore);
    check('Monday was replaced by the file', State.lineRoster.grid['1'][slotIds[0]].L1 === 'r0');

    console.log('\n26. Name matching against the agent roster');
    check('exact name', (L.matchAgentByName('Ganesh') || {}).name === 'Ganesh');
    check('case-insensitive', (L.matchAgentByName('  krishna ') || {}).name === 'Krishna');
    check('a typo matches nobody', L.matchAgentByName('Rhul') === null);
    check('blank matches nobody', L.matchAgentByName('   ') === null);
    State.agents = ROSTER_AGENTS.concat([{ id: 'rx', name: 'Ram Narayana', role: 'support', isAvailable: true }]);
    check('an exact match still wins over a first-name match', (L.matchAgentByName('Ram') || {}).id === 'r0');
    check('a first name resolves to the full name when unique', (L.matchAgentByName('Narayana') || {}) .id === undefined);
    State.agents = ROSTER_AGENTS;
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
