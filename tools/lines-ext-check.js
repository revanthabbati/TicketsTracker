#!/usr/bin/env node
/**
 * Browser-extension call-line check — verifies the extension can write to the shared
 * Firestore document without destroying anyone else's data.
 *
 *   node tools/lines-ext-check.js
 *
 * Why this exists: until v1.4.0 the extension only ever GET the tracker document. Checking in
 * and out of a line means writing `lineSessions` and `agents`, which everyone on shift writes
 * at once. A plain read-append-PATCH would silently erase whoever committed in between --
 * the same class of bug that once wiped five user accounts from `users`.
 *
 * The extension has no Firebase SDK and so no runTransaction; it uses an updateTime
 * precondition on the REST commit instead. That is the thing most worth testing, and it
 * cannot be tested by clicking, so `fetch` is faked here with a server that enforces
 * Firestore's actual REST contract:
 *
 *   - values must be correctly type-tagged, and integerValue must be a STRING (Firestore
 *     rejects a JSON number there -- an easy encoder bug that only shows up in production)
 *   - a commit whose currentDocument.updateTime no longer matches is rejected with
 *     FAILED_PRECONDITION, exactly as Google's does
 *   - updateMask means untouched fields must survive the write
 *
 * It extracts the real functions from browser-extension/firestore.js at runtime, so it cannot
 * drift from what ships. No network, no credentials, no production data.
 *
 * NOTE: this proves the write LOGIC is correct. It cannot prove that the Firestore security
 * rules allow an unauthenticated REST write -- only a real request can, and that has to be
 * done by loading the extension.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'firestore.js'), 'utf8');

// ---- fake Firestore --------------------------------------------------------
let doc, updateTime, commitCount, onBeforeCommit;

function reset(initial) {
    doc = JSON.parse(JSON.stringify(initial));
    updateTime = '2026-09-16T00:00:00.000000Z';
    commitCount = 0;
    onBeforeCommit = null;
}

function bumpTime() {
    updateTime = new Date(new Date(updateTime).getTime() + 1000).toISOString().replace('Z', '000Z');
}

// Strict: mirrors what Google actually accepts, so an encoder bug fails here not in production.
function decodeStrict(value, where) {
    if (value == null) throw new Error(`null value at ${where}`);
    const keys = Object.keys(value);
    if (keys.length !== 1) throw new Error(`value at ${where} must have exactly one type tag, got ${keys.join(',')}`);
    const tag = keys[0];
    if (tag === 'stringValue') { if (typeof value.stringValue !== 'string') throw new Error(`stringValue at ${where} must be a string`); return value.stringValue; }
    if (tag === 'booleanValue') { if (typeof value.booleanValue !== 'boolean') throw new Error(`booleanValue at ${where} must be boolean`); return value.booleanValue; }
    if (tag === 'nullValue') return null;
    if (tag === 'integerValue') {
        if (typeof value.integerValue !== 'string') throw new Error(`integerValue at ${where} must be a STRING (Firestore rejects a JSON number)`);
        return Number(value.integerValue);
    }
    if (tag === 'doubleValue') { if (typeof value.doubleValue !== 'number') throw new Error(`doubleValue at ${where} must be a number`); return value.doubleValue; }
    if (tag === 'mapValue') {
        const out = {};
        const f = (value.mapValue && value.mapValue.fields) || {};
        Object.keys(f).forEach(k => { out[k] = decodeStrict(f[k], `${where}.${k}`); });
        return out;
    }
    if (tag === 'arrayValue') {
        const vals = (value.arrayValue && value.arrayValue.values) || [];
        return vals.map((v, i) => decodeStrict(v, `${where}[${i}]`));
    }
    throw new Error(`unsupported type tag ${tag} at ${where}`);
}

function encode(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
    const fields = {};
    Object.keys(v).forEach(k => { if (v[k] !== undefined) fields[k] = encode(v[k]); });
    return { mapValue: { fields } };
}

async function fakeFetch(url, opts) {
    if (!opts || !opts.method) {
        const fields = {};
        Object.keys(doc).forEach(k => { fields[k] = encode(doc[k]); });
        return { ok: true, status: 200, json: async () => ({ fields, updateTime }) };
    }
    // commit
    commitCount++;
    if (onBeforeCommit) { const fn = onBeforeCommit; onBeforeCommit = null; fn(); }

    const body = JSON.parse(opts.body);
    const write = body.writes[0];
    const pre = write.currentDocument && write.currentDocument.updateTime;
    if (pre !== updateTime) {
        return {
            ok: false, status: 400,
            json: async () => ({ error: { status: 'FAILED_PRECONDITION', message: 'document has been modified' } })
        };
    }
    const mask = write.updateMask.fieldPaths;
    const incoming = write.update.fields;
    if (Object.keys(incoming).sort().join() !== mask.slice().sort().join()) {
        throw new Error('updateMask does not match the fields sent');
    }
    mask.forEach(k => { doc[k] = decodeStrict(incoming[k], k); });
    bumpTime();
    return { ok: true, status: 200, json: async () => ({}) };
}

// ---- load the real code ----------------------------------------------------
const globals = {
    fetch: fakeFetch,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, action: { setBadgeText() {}, setBadgeBackgroundColor() {} } },
    crypto: { randomUUID: () => 'id-' + Math.random().toString(16).slice(2) },
    console,
    btoa: s => Buffer.from(s, 'binary').toString('base64')
};
const factory = new Function(...Object.keys(globals), `
    ${src}
    return { toFirestoreValue, updateSharedFields, lineCheckIn, lineCheckOut, setPresence, fetchState,
             upcomingRosterDuty, rosterLinesFrom, rosterDayFor, isAgentOnBreak, isAgentOnShiftNow };
`);
const X = factory(...Object.values(globals));
const { upcomingRosterDuty } = X;

// ---- test rig --------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const BASE = {
    users: [{ id: 'u1', email: 'a@b.c' }],
    tickets: [{ id: 't1' }],
    agents: [
        { id: 'ag1', name: 'Asha', isAvailable: true, zendeskEmail: 'asha@x.com' },
        { id: 'ag2', name: 'Ben', isAvailable: true, zendeskEmail: 'ben@x.com' }
    ],
    lines: [
        { id: 'L1', name: 'Line 1', capacity: 1, isActive: true, order: 0 },
        { id: 'L2', name: 'Line 2', capacity: null, isActive: true, order: 1 },
        { id: 'L3', name: 'Line 3', capacity: 2, isActive: false, order: 2 }
    ],
    lineSessions: []
};

(async () => {
    console.log('\n1. Value encoding matches what Firestore accepts');
    reset(BASE);
    const enc = X.toFirestoreValue({ n: 42, f: 1.5, s: 'x', b: true, nil: null, arr: [1, 'a'], nested: { k: 'v' } });
    check('integers encode as STRING', enc.mapValue.fields.n.integerValue === '42', JSON.stringify(enc.mapValue.fields.n));
    check('floats encode as doubleValue', enc.mapValue.fields.f.doubleValue === 1.5);
    check('nulls encode as nullValue', 'nullValue' in enc.mapValue.fields.nil);
    check('arrays encode as arrayValue', Array.isArray(enc.mapValue.fields.arr.arrayValue.values));
    check('nested objects encode as mapValue', enc.mapValue.fields.nested.mapValue.fields.k.stringValue === 'v');
    const withUndef = X.toFirestoreValue({ a: 1, b: undefined });
    check('undefined keys are dropped, not sent as null', !('b' in withUndef.mapValue.fields));

    console.log('\n2. Check-in writes only lineSessions and leaves the rest untouched');
    reset(BASE);
    let r = await X.lineCheckIn('ag1', 'Asha', 'L1');
    check('check-in ok', r.ok && !r.skipped, JSON.stringify(r));
    check('one open session', doc.lineSessions.filter(s => !s.checkOutAt).length === 1);
    check('users untouched', doc.users.length === 1 && doc.users[0].email === 'a@b.c');
    check('tickets untouched', doc.tickets.length === 1);
    check('agents untouched', doc.agents.length === 2 && doc.agents[0].isAvailable === true);
    check('lines untouched', doc.lines.length === 3);

    console.log('\n3. Capacity is enforced against the live document');
    r = await X.lineCheckIn('ag2', 'Ben', 'L1');
    check('second agent refused on a 1-seat line', r.skipped && /full/.test(r.reason || ''), JSON.stringify(r));
    check('still one occupant', doc.lineSessions.filter(s => !s.checkOutAt).length === 1);

    console.log('\n4. A closed line refuses check-in');
    r = await X.lineCheckIn('ag2', 'Ben', 'L3');
    check('refused', r.skipped && /closed/.test(r.reason || ''), JSON.stringify(r));

    console.log('\n5. Switching lines closes the previous session');
    r = await X.lineCheckIn('ag1', 'Asha', 'L2');
    check('switch ok', r.ok && !r.skipped);
    check('exactly one open for Asha', doc.lineSessions.filter(s => !s.checkOutAt && s.agentId === 'ag1').length === 1);
    check('previous closed with reason=switch', doc.lineSessions.some(s => s.checkOutAt && s.endedReason === 'switch'));
    check('now on Line 2', doc.lineSessions.find(s => !s.checkOutAt && s.agentId === 'ag1').lineName === 'Line 2');

    console.log('\n6. Check-out records a duration');
    doc.lineSessions.find(s => !s.checkOutAt).checkInAt = new Date(Date.now() - 30 * 60000).toISOString();
    r = await X.lineCheckOut('ag1');
    check('check-out ok', r.ok && !r.skipped);
    check('~30 min recorded', Math.abs(doc.lineSessions.find(s => s.agentId === 'ag1' && s.endedReason === 'manual').durationMs - 30 * 60000) < 5000);
    r = await X.lineCheckOut('ag1');
    check('second check-out is a no-op', r.skipped && /not checked in/.test(r.reason || ''));

    console.log('\n7. Away closes the line session AND clears floor availability, in one commit');
    reset(BASE);
    await X.lineCheckIn('ag1', 'Asha', 'L1');
    const commitsBefore = commitCount;
    r = await X.setPresence('ag1', true);
    check('away ok', r.ok && !r.skipped, JSON.stringify(r));
    check('exactly one commit (never half-applied)', commitCount - commitsBefore === 1, String(commitCount - commitsBefore));
    check('isAvailable cleared', doc.agents.find(a => a.id === 'ag1').isAvailable === false);
    check('presence recorded', doc.agents.find(a => a.id === 'ag1').presence === 'away');
    check('line session closed as a break', doc.lineSessions.some(s => s.endedReason === 'break'));
    check('nobody left on a line', doc.lineSessions.filter(s => !s.checkOutAt).length === 0);
    check('the line they left is remembered', doc.agents.find(a => a.id === 'ag1').awayFromLineId === 'L1');
    check('the OTHER agent is untouched', doc.agents.find(a => a.id === 'ag2').isAvailable === true);

    console.log('\n8. Coming back restores availability and reports the line to resume');
    r = await X.setPresence('ag1', false);
    check('back ok', r.ok);
    check('isAvailable restored', doc.agents.find(a => a.id === 'ag1').isAvailable === true);
    check('presence cleared', doc.agents.find(a => a.id === 'ag1').presence === 'in');
    check('resume line reported to the caller', r.info && r.info.resumeLineId === 'L1', JSON.stringify(r.info));
    check('remembered line cleared', doc.agents.find(a => a.id === 'ag1').awayFromLineId === '');

    console.log('\n9. A concurrent write is detected and retried, not clobbered');
    reset(BASE);
    // Somebody else checks in (and bumps updateTime) after our read but before our commit.
    onBeforeCommit = () => {
        doc.lineSessions = doc.lineSessions.concat([{
            id: 'other', lineId: 'L2', lineName: 'Line 2', agentId: 'ag2', agentName: 'Ben',
            checkInAt: new Date().toISOString(), checkOutAt: null, durationMs: 0, endedReason: ''
        }]);
        bumpTime();
    };
    r = await X.lineCheckIn('ag1', 'Asha', 'L2');
    check('our write still succeeded', r.ok && !r.skipped, JSON.stringify(r));
    check('it took more than one commit attempt', commitCount >= 2, `${commitCount} commits`);
    check("the other agent's session SURVIVED", doc.lineSessions.some(s => s.id === 'other'), JSON.stringify(doc.lineSessions.map(s => s.agentName)));
    check('both agents are on the line', doc.lineSessions.filter(s => !s.checkOutAt).length === 2);

    console.log('\n10. A racing write that keeps losing gives up rather than forcing');
    reset(BASE);
    const realFetch = globals.fetch;
    let always = 0;
    globals.fetch = async (url, opts) => {
        if (opts && opts.method) { always++; bumpTime(); }   // always conflict
        return realFetch(url, opts);
    };
    const X2 = new Function(...Object.keys(globals), `${src}\nreturn { lineCheckIn };`)(...Object.values(globals));
    r = await X2.lineCheckIn('ag1', 'Asha', 'L2');
    check('reports a conflict instead of overwriting', r.ok === false && r.conflict === true, JSON.stringify(r));
    check('gave up after a bounded number of attempts', always <= 5, `${always} attempts`);
    check('nothing was written', doc.lineSessions.length === 0);
    globals.fetch = realFetch;

    console.log('\n11. fetchState exposes the new arrays');
    reset(BASE);
    const st = await X.fetchState();
    check('lines returned', Array.isArray(st.lines) && st.lines.length === 3);
    check('lineSessions returned', Array.isArray(st.lineSessions));
    check('existing fields still returned', Array.isArray(st.tickets) && Array.isArray(st.agents));


    console.log('\n12. Roster reminders: which line, and when');
    const SLOTS = [
        { id: 'slot-1', label: '9 to 11', start: '21:00', end: '23:00' },
        { id: 'slot-2', label: '11 to 1', start: '23:00', end: '01:00' },
        { id: 'slot-3', label: '1 to 3', start: '01:00', end: '03:00' },
        { id: 'slot-4', label: '3 to 5', start: '03:00', end: '05:00' },
        { id: 'slot-5', label: '5 to 6', start: '05:00', end: '06:00' }
    ];
    const RSTATE = {
        lines: [
            { id: 'L1', name: 'Line 1', order: 0 },
            { id: 'L2', name: 'Line 2 / Opsmon', order: 1 },
            { id: 'L3', name: 'Line 3', order: 2 },
            { id: 'L9', name: 'Line 9', order: 3 }
        ],
        lineRoster: {
            slots: SLOTS,
            grid: {
                // Monday (rota day 1)
                '1': {
                    'slot-1': { L1: 'me', L2: 'other' },
                    'slot-2': { L2: 'me' },
                    'slot-3': { L3: 'other' }
                },
                '2': { 'slot-1': { L1: 'other' } }
            }
        }
    };
    // Monday 2026-09-14 20:55 -> the 21:00 block is five minutes away.
    const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
    let duty = upcomingRosterDuty(RSTATE, 'me', at(2026, 9, 14, 20, 55), 5);
    check('warns five minutes before the block', !!duty, JSON.stringify(duty));
    check('names the right line', duty && duty.lineName === 'Line 1', duty && duty.lineName);
    check('reports the minutes left', duty && duty.minutesUntil === 5, duty && String(duty.minutesUntil));
    check('key identifies day, slot and line', duty && duty.key === '1|slot-1|L1', duty && duty.key);

    check('nothing six minutes out', upcomingRosterDuty(RSTATE, 'me', at(2026, 9, 14, 20, 54), 5) === null);
    check('still fires one minute out', !!upcomingRosterDuty(RSTATE, 'me', at(2026, 9, 14, 20, 59), 5));
    check('nothing once the block has started', upcomingRosterDuty(RSTATE, 'me', at(2026, 9, 14, 21, 1), 5) === null);
    check('nothing for a block somebody else has', upcomingRosterDuty(RSTATE, 'other', at(2026, 9, 14, 20, 55), 5).lineName === 'Line 2 / Opsmon');

    console.log('\n13. Reminders across midnight and the 6am rota rollover');
    // 22:55 Monday -> the 23:00 block, still Monday's rota.
    duty = upcomingRosterDuty(RSTATE, 'me', at(2026, 9, 14, 22, 55), 5);
    check('the 23:00 block is found', !!duty && duty.slotId === 'slot-2', JSON.stringify(duty));
    check('and on the right line', duty && duty.lineName === 'Line 2 / Opsmon');
    // 00:55 on Tuesday morning is still MONDAY's rota (day rolls at 6am), so the 01:00
    // block belongs to Monday and is assigned to "other", not to "me".
    duty = upcomingRosterDuty(RSTATE, 'me', at(2026, 9, 15, 0, 55), 5);
    check('after midnight the rota day is still the previous evening', duty === null, JSON.stringify(duty));
    duty = upcomingRosterDuty(RSTATE, 'other', at(2026, 9, 15, 0, 55), 5);
    check('and the block resolves to whoever Monday has on it', !!duty && duty.day === 1 && duty.lineName === 'Line 3', JSON.stringify(duty));

    console.log('\n14. Reminders only cover the roster lines');
    const OFF_ROSTER = JSON.parse(JSON.stringify(RSTATE));
    OFF_ROSTER.lineRoster.grid['1']['slot-1'] = { L9: 'me' };
    check('a line outside the roster set is ignored',
        upcomingRosterDuty(OFF_ROSTER, 'me', at(2026, 9, 14, 20, 55), 5) === null);
    const EXPLICIT = JSON.parse(JSON.stringify(RSTATE));
    EXPLICIT.lines = EXPLICIT.lines.map(l => ({ ...l, inRoster: l.id === 'L9' }));
    EXPLICIT.lineRoster.grid['1']['slot-1'] = { L9: 'me' };
    check('but an explicit inRoster flag is honoured',
        (upcomingRosterDuty(EXPLICIT, 'me', at(2026, 9, 14, 20, 55), 5) || {}).lineName === 'Line 9');

    console.log('\n15. Reminders degrade safely');
    check('no agent id', upcomingRosterDuty(RSTATE, '', at(2026, 9, 14, 20, 55), 5) === null);
    check('no roster at all', upcomingRosterDuty({ lines: RSTATE.lines }, 'me', at(2026, 9, 14, 20, 55), 5) === null);
    check('roster with no slots', upcomingRosterDuty({ lines: RSTATE.lines, lineRoster: { slots: [], grid: {} } }, 'me', new Date(), 5) === null);
    check('empty state', upcomingRosterDuty({}, 'me', new Date(), 5) === null);

    console.log('\n16. The Calls tab lists breaks, not people who are off shift');
    // Reported from the popup: "On a break — Ganesh Thota, Sriharsha Gajji, Shay Powell",
    // who were simply outside their working hours at the time.
    const everyDay = t => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, t]));
    const sh = (a, b) => ({ start: a, end: b });
    const AT = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
    const at2300 = AT(2026, 9, 16, 23, 0);
    const at0200 = AT(2026, 9, 16, 2, 0);
    const away = shifts => ({ presence: 'away', isAvailable: false, shifts });

    check('13:00-22:00 is not a break at 23:00',
        X.isAgentOnBreak(away(everyDay(sh('13:00', '22:00'))), at2300) === false);
    check('04:00-14:00 is not a break at 23:00',
        X.isAgentOnBreak(away(everyDay(sh('04:00', '14:00'))), at2300) === false);
    check('18:30-02:30 IS a break at 23:00 (they are mid-shift)',
        X.isAgentOnBreak(away(everyDay(sh('18:30', '02:30'))), at2300) === true);
    check('21:00-06:00 IS a break at 23:00',
        X.isAgentOnBreak(away(everyDay(sh('21:00', '06:00'))), at2300) === true);
    check('21:00-06:00 is still a break at 02:00 (overnight)',
        X.isAgentOnBreak(away(everyDay(sh('21:00', '06:00'))), at0200) === true);
    check('13:00-22:00 is not a break at 02:00',
        X.isAgentOnBreak(away(everyDay(sh('13:00', '22:00'))), at0200) === false);
    check('available agents are never on a break',
        X.isAgentOnBreak({ presence: 'away', isAvailable: true, shifts: everyDay(sh('21:00', '06:00')) }, at2300) === false);
    check('unavailable without the away flag is not a break',
        X.isAgentOnBreak({ presence: 'in', isAvailable: false, shifts: everyDay(sh('21:00', '06:00')) }, at2300) === false);
    check('an agent with no shifts recorded still reports a real break',
        X.isAgentOnBreak({ presence: 'away', isAvailable: false, shifts: {} }, at2300) === true);
    check('undefined is safe', X.isAgentOnBreak(undefined, at2300) === false);
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
