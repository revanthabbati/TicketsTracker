#!/usr/bin/env node
/**
 * Notification check — verifies the extension does not re-notify tickets it has already
 * announced, by running its real polling function over a fake chrome.storage across many
 * consecutive polls.
 *
 *   node tools/notify-check.js
 *
 * Why this exists: agents reported the extension announcing their whole backlog again and
 * again, including tickets they had marked as read. The cause was a one-line retention bug
 * that only appears once an agent has more than MAX_KNOWN_IDS tickets -- so it could not be
 * reproduced on a small test account, and nothing in the UI showed it. The regression test
 * for it has to simulate scale and repetition, which is exactly what clicking cannot do.
 *
 * It extracts checkForNewAssignments and its helpers from background.js at runtime, so it
 * tests what actually ships. No network, no credentials, no production data.
 */

const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'browser-extension');
const shared = fs.readFileSync(path.join(EXT, 'firestore.js'), 'utf8');
const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8').replace(/^importScripts\([^)]*\);?/m, '');

// ---- fakes -----------------------------------------------------------------
let store, notifications, badge, quotaBytes, tickets, storageWrites;

function resetWorld(ticketCount, agentId) {
    store = {};
    notifications = [];
    badge = null;
    quotaBytes = Infinity;
    storageWrites = 0;
    // Newest first, matching what the real sort produces.
    tickets = Array.from({ length: ticketCount }, (_, i) => ({
        id: 'T' + String(i).padStart(4, '0'),
        agentId,
        link: 'https://x.zendesk.com/agent/tickets/' + (1000 + i),
        date: '2026-10-01',
        time: '09:00 am',
        irSent: false
    }));
}

const chromeStub = {
    storage: {
        local: {
            get: async keys => {
                const out = {};
                (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in store) out[k] = store[k]; });
                return out;
            },
            set: async obj => {
                storageWrites++;
                const next = { ...store, ...obj };
                if (JSON.stringify(next).length > quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
                Object.assign(store, obj);
            },
            remove: async k => { delete store[k]; }
        }
    },
    action: { setBadgeText: ({ text }) => { badge = text; }, setBadgeBackgroundColor: () => {} },
    notifications: {
        create: (id, opts) => notifications.push({ id, ...opts }),
        clear: () => {},
        onClicked: { addListener: () => {} }
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} }, sendMessage: () => {} },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} }
};

const globals = {
    chrome: chromeStub,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ fields: {} }) }),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    crypto: { randomUUID: () => 'id-' + Math.random().toString(16).slice(2) },
    // The poller's own data source and its Zendesk enrichment are stubbed; this harness is
    // about which tickets get announced, not about fetching them.
    __fetchState: async () => ({ tickets, settings: {}, agents: [], lines: [], lineSessions: [], lineRoster: {} })
};

const src = `
    ${shared}
    ${bg}
    fetchState = __fetchState;
    enrichWithSubjects = async () => {};
    checkUnassignedQueue = async () => {};
    checkRosterDuty = async () => {};
    maybePlayAlertSound = async () => {};
    return { checkForNewAssignments, markTicketsRead, MAX_KNOWN_IDS };
`;
const X = new Function(...Object.keys(globals), src)(...Object.values(globals));

// ---- test rig --------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
const notifiedCount = () => notifications.reduce((n, x) =>
    n + (/^summary-/.test(x.id) ? Number((x.message.match(/^(\d+)/) || [0, 0])[1]) : 1), 0);

(async () => {
    console.log('\n1. A small account settles after the first poll');
    resetWorld(10, 'me');
    store.agentId = 'me';
    await X.checkForNewAssignments();             // seeds
    check('the seeding poll announces nothing', notifications.length === 0, JSON.stringify(notifications.slice(0, 2)));
    check('and remembers every ticket', store.knownTicketIds.length === 10);
    for (let i = 0; i < 5; i++) await X.checkForNewAssignments();
    check('five more polls announce nothing', notifications.length === 0, String(notifiedCount()));

    console.log('\n2. A genuinely new ticket is announced exactly once');
    tickets.unshift({ id: 'NEW1', agentId: 'me', link: 'https://x/1', date: '2026-10-01', time: '10:00 am', irSent: false });
    await X.checkForNewAssignments();
    check('announced', notifiedCount() === 1, String(notifiedCount()));
    for (let i = 0; i < 4; i++) await X.checkForNewAssignments();
    check('not announced again on later polls', notifiedCount() === 1, String(notifiedCount()));

    console.log('\n3. THE REPORTED BUG: more tickets than the retention cap');
    // Over MAX_KNOWN_IDS, the old code kept the LAST n of [known, ...current]. current is
    // sorted newest-first, so the tail was the OLDEST -- the newest ids fell out every poll
    // and were re-announced for ever.
    const big = X.MAX_KNOWN_IDS + 60;
    resetWorld(big, 'me');
    store.agentId = 'me';
    await X.checkForNewAssignments();             // seed
    await X.checkForNewAssignments();             // one-time repair
    notifications.length = 0;
    for (let i = 0; i < 6; i++) await X.checkForNewAssignments();
    check(`${big} tickets, six polls, nothing re-announced`, notifiedCount() === 0, notifiedCount() + ' announced');
    check('every current ticket is still remembered',
        tickets.every(t => store.knownTicketIds.includes(t.id)),
        tickets.filter(t => !store.knownTicketIds.includes(t.id)).length + ' forgotten');

    console.log('\n4. A ticket marked as read is never announced again');
    resetWorld(20, 'me');
    store.agentId = 'me';
    await X.checkForNewAssignments();
    await X.checkForNewAssignments();
    // Simulate the list being lost or truncated entirely -- the worst case the backstop is for.
    await X.markTicketsRead(tickets.map(t => t.id));
    store.knownTicketIds = [];
    notifications.length = 0;
    await X.checkForNewAssignments();
    check('a wiped known-list does not re-announce read tickets', notifiedCount() === 0, notifiedCount() + ' announced');
    check('they are back in the known list afterwards', store.knownTicketIds.length === 20);

    console.log('\n5. Unread tickets still get through when the list is lost');
    resetWorld(5, 'me');
    store.agentId = 'me';
    await X.checkForNewAssignments();
    await X.checkForNewAssignments();
    await X.markTicketsRead([tickets[0].id, tickets[1].id]);
    store.knownTicketIds = [];
    notifications.length = 0;
    await X.checkForNewAssignments();
    check('only the three unread ones are announced', notifiedCount() === 3, String(notifiedCount()));

    console.log('\n6. A full storage quota must not cause a notification loop');
    resetWorld(12, 'me');
    store.agentId = 'me';
    await X.checkForNewAssignments();
    await X.checkForNewAssignments();
    notifications.length = 0;
    // Enough room for the ids, not for the bulky popup cache.
    quotaBytes = JSON.stringify({ ...store, myTickets: undefined }).length + 400;
    let threw = null;
    try {
        for (let i = 0; i < 4; i++) await X.checkForNewAssignments();
    } catch (err) { threw = String(err.message || err); }
    check('polling survives a failed cache write', threw === null, threw);
    check('and still announces nothing', notifiedCount() === 0, notifiedCount() + ' announced');
    check('the ids were saved even though the cache could not be', Array.isArray(store.knownTicketIds) && store.knownTicketIds.length === 12);

    console.log('\n7. Switching identity does not announce the new person\'s history');
    resetWorld(8, 'me');
    store.agentId = 'me';
    await X.checkForNewAssignments();
    await X.checkForNewAssignments();
    // options.js clears knownTicketIds when the identity changes.
    tickets.forEach(t => { t.agentId = 'someone-else'; });
    delete store.knownTicketIds;
    delete store.knownIdsRepaired;
    store.agentId = 'someone-else';
    notifications.length = 0;
    await X.checkForNewAssignments();
    check('the new identity is seeded silently', notifiedCount() === 0, String(notifiedCount()));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
