// Shared read-only Firestore REST helper. Same public doc the main tracker app
// (index.html) already reads/writes client-side with a public Firebase web API
// key -- this extension only ever GETs it, never writes.
const FIRESTORE_DOC_URL =
    'https://firestore.googleapis.com/v1/projects/routerpro-bbf42/databases/(default)/documents/routerpro/system_state_v11';

// Firestore's REST API returns every value wrapped in a type tag
// (e.g. {stringValue: "x"} or {arrayValue: {values: [...]}}) instead of plain
// JSON. This unwraps that recursively into ordinary JS values/objects/arrays.
function parseFirestoreValue(value) {
    if (value == null) return null;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return value.doubleValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('nullValue' in value) return null;
    if ('timestampValue' in value) return value.timestampValue;
    if ('mapValue' in value) {
        const out = {};
        const fields = (value.mapValue && value.mapValue.fields) || {};
        for (const key in fields) out[key] = parseFirestoreValue(fields[key]);
        return out;
    }
    if ('arrayValue' in value) {
        const values = (value.arrayValue && value.arrayValue.values) || [];
        return values.map(parseFirestoreValue);
    }
    return null;
}

function parseFirestoreFields(fields, key) {
    if (!fields || !fields[key]) return [];
    return parseFirestoreValue(fields[key]) || [];
}

// Fetches the tracker's shared state doc and returns plain { tickets, agents,
// settings, lines, lineSessions } data. Throws on any network/HTTP failure -- callers decide how
// to handle it.
async function fetchState() {
    const res = await fetch(FIRESTORE_DOC_URL);
    if (!res.ok) throw new Error(`Firestore returned ${res.status}`);
    const data = await res.json();
    const fields = data.fields || {};
    return {
        tickets: parseFirestoreFields(fields, 'tickets'),
        agents: parseFirestoreFields(fields, 'agents'),
        settings: fields.settings ? parseFirestoreValue(fields.settings) : {},
        lines: parseFirestoreFields(fields, 'lines'),
        lineSessions: parseFirestoreFields(fields, 'lineSessions')
    };
}

// Manually-pasted tickets only ever carry a `link`; Zendesk Queue tickets also
// carry `zendeskId`. Either way we need the real numeric Zendesk ticket id to
// look up its subject.
function extractZendeskTicketId(t) {
    if (t.zendeskId) return Number(t.zendeskId);
    const match = /(\d+)\/?$/.exec((t.link || '').trim());
    return match ? Number(match[1]) : null;
}

// Batch-resolves ticket subjects through the same Cloudflare Worker proxy +
// shared API token the main app already uses (index.html's zendeskFetch) --
// same credentials, same host, nothing new to trust.
async function fetchTicketSubjects(zendeskSettings, ticketIds) {
    if (!zendeskSettings || !zendeskSettings.subdomain || !zendeskSettings.apiToken || !zendeskSettings.email || !zendeskSettings.proxyUrl) return {};
    if (!ticketIds || ticketIds.length === 0) return {};

    const authValue = btoa(`${zendeskSettings.email}/token:${zendeskSettings.apiToken}`);
    const proxyUrl = zendeskSettings.proxyUrl.replace(/\/+$/, '');
    const result = {};
    const CHUNK_SIZE = 100;

    for (let i = 0; i < ticketIds.length; i += CHUNK_SIZE) {
        const chunk = ticketIds.slice(i, i + CHUNK_SIZE);
        const target = `https://${zendeskSettings.subdomain}.zendesk.com/api/v2/tickets/show_many.json?ids=${chunk.join(',')}`;
        const url = `${proxyUrl}?target=${encodeURIComponent(target)}`;
        try {
            const res = await fetch(url, { headers: { Authorization: `Basic ${authValue}` } });
            if (!res.ok) continue;
            const data = await res.json();
            (data.tickets || []).forEach(zt => { result[zt.id] = zt.subject || ''; });
        } catch (err) {
            console.error('Tracker Notifier: failed to fetch ticket subjects', err);
        }
    }
    return result;
}

// Same search the main app's Zendesk Queue "Unassigned" tab uses, returning
// the actual tickets (first page, same as the main app -- no pagination
// handling there either, since a backlog past ~100 is its own problem to
// notice). Callers needing just a count use the returned array's length.
async function fetchUnassignedTickets(zendeskSettings) {
    if (!zendeskSettings || !zendeskSettings.subdomain || !zendeskSettings.apiToken || !zendeskSettings.email || !zendeskSettings.proxyUrl) return [];

    const authValue = btoa(`${zendeskSettings.email}/token:${zendeskSettings.apiToken}`);
    const proxyUrl = zendeskSettings.proxyUrl.replace(/\/+$/, '');
    const query = 'type:ticket status<solved assignee:none';
    const target = `https://${zendeskSettings.subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=asc`;
    const url = `${proxyUrl}?target=${encodeURIComponent(target)}`;

    const res = await fetch(url, { headers: { Authorization: `Basic ${authValue}` } });
    if (!res.ok) throw new Error(`Zendesk returned ${res.status}`);
    const data = await res.json();
    return data.results || [];
}

// Adds a `.subject` field to each ticket in place, using a persisted cache so
// only genuinely-new Zendesk ticket ids ever need a live API call. Shared by
// background.js and popup.js -- both load this file, one via importScripts,
// one via a <script> tag.
async function enrichWithSubjects(myTickets, zendeskSettings) {
    const { ticketSubjects = {} } = await chrome.storage.local.get('ticketSubjects');
    const zidByTicketId = new Map();
    const idsNeeded = new Set();

    myTickets.forEach(t => {
        const zid = extractZendeskTicketId(t);
        if (zid == null) return;
        zidByTicketId.set(t.id, zid);
        if (ticketSubjects[zid] == null) idsNeeded.add(zid);
    });

    let cache = ticketSubjects;
    if (idsNeeded.size > 0 && zendeskSettings) {
        const fetched = await fetchTicketSubjects(zendeskSettings, Array.from(idsNeeded));
        cache = Object.fromEntries(Object.entries({ ...ticketSubjects, ...fetched }).slice(-MAX_CACHED_SUBJECTS));
        await chrome.storage.local.set({ ticketSubjects: cache });
    }

    myTickets.forEach(t => {
        const zid = zidByTicketId.get(t.id);
        if (zid != null && cache[zid] != null) t.subject = cache[zid];
    });
}

// A ticket's own id is an internal UUID, not something an agent recognizes --
// this is the same short human reference the main app itself computes from
// the pasted link, falling back to the real Zendesk ticket id when present.
function ticketRef(t) {
    if (t.zendeskId) return String(t.zendeskId);
    const fromLink = (t.link || '').split('/').pop().substring(0, 8);
    return fromLink || 'Ticket';
}

// Mirrors the main app's parseTicketTimestamp (index.html) -- tickets only
// store a date ("YYYY-MM-DD") and a 12-hour time string ("06:05 am")
// separately, so this reconstructs a real Date for sorting/display.
function parseTicketTimestamp(t) {
    const d = new Date(`${t.date}T00:00:00`);
    const match = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(t.time || '');
    if (match) {
        let hours = parseInt(match[1], 10) % 12;
        const minutes = parseInt(match[2], 10);
        if (/pm/i.test(match[3])) hours += 12;
        d.setHours(hours, minutes, 0, 0);
    }
    return d;
}

const MAX_READ_IDS = 500;
const MAX_CACHED_SUBJECTS = 1000;
const BADGE_RED = '#f43f5e';
const BADGE_GREEN = '#10b981';

// "Read" is a separate concept from irSent -- irSent is a fact about the
// ticket itself (shared, comes from Firestore); read/unread is purely this
// browser's local acknowledgment that *this agent* has seen it, so it never
// touches Firestore.
function unreadTickets(myTickets, readTicketIds) {
    const readSet = new Set(readTicketIds || []);
    return myTickets.filter(t => !readSet.has(t.id));
}

function computeBadge(myTickets, readTicketIds) {
    const unread = unreadTickets(myTickets, readTicketIds);
    if (unread.length === 0) return { text: '', color: null };
    const pending = unread.filter(t => !t.irSent).length;
    if (pending > 0) return { text: String(Math.min(pending, 99)), color: BADGE_RED };
    return { text: '✓', color: BADGE_GREEN };
}

function applyBadge(badge) {
    if (!badge.text) {
        chrome.action.setBadgeText({ text: '' });
        return;
    }
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
    chrome.action.setBadgeText({ text: badge.text });
}

// Shared by background.js (notification click) and popup.js (mark-read
// button) -- both just mutate the same chrome.storage.local state, then
// recompute the badge from whatever myTickets snapshot is currently cached.
async function markTicketsRead(ticketIds) {
    const { readTicketIds = [], myTickets = [] } = await chrome.storage.local.get(['readTicketIds', 'myTickets']);
    const updated = Array.from(new Set([...readTicketIds, ...ticketIds])).slice(-MAX_READ_IDS);
    await chrome.storage.local.set({ readTicketIds: updated });
    applyBadge(computeBadge(myTickets, updated));
    return updated;
}

async function markTicketsUnread(ticketIds) {
    const { readTicketIds = [], myTickets = [] } = await chrome.storage.local.get(['readTicketIds', 'myTickets']);
    const removeSet = new Set(ticketIds);
    const updated = readTicketIds.filter(id => !removeSet.has(id));
    await chrome.storage.local.set({ readTicketIds: updated });
    applyBadge(computeBadge(myTickets, updated));
    return updated;
}

/* --- WRITING (call lines) ---
   Until now this extension was strictly read-only. Checking in and out of a line means it
   has to write, and `lineSessions` is a shared array that everyone on shift writes at once --
   exactly the shape of data that a naive read-append-PATCH destroys, because it would
   overwrite anyone who wrote between our read and our write. The main app avoids that with
   runTransaction; over the REST API the equivalent is an updateTime precondition, below. */

const FIRESTORE_DOC_NAME =
    'projects/routerpro-bbf42/databases/(default)/documents/routerpro/system_state_v11';
const FIRESTORE_COMMIT_URL =
    'https://firestore.googleapis.com/v1/projects/routerpro-bbf42/databases/(default)/documents:commit';

// The inverse of parseFirestoreValue. Integers have to go out as strings -- Firestore's REST
// API returns integerValue as a string and rejects a JSON number there.
function toFirestoreValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') {
        if (!isFinite(v)) return { nullValue: null };
        return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
    if (typeof v === 'object') {
        const fields = {};
        // undefined is not representable in Firestore and makes the whole commit 400, so
        // those keys are dropped rather than sent as null -- dropping matches how the web
        // SDK behaves for an absent property.
        Object.keys(v).forEach(k => { if (v[k] !== undefined) fields[k] = toFirestoreValue(v[k]); });
        return { mapValue: { fields } };
    }
    return { nullValue: null };
}

// Same GET as fetchState, but keeps the document's updateTime, which is the token the
// conditional write below needs.
async function fetchDocSnapshot() {
    const res = await fetch(FIRESTORE_DOC_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Firestore returned ${res.status}`);
    const data = await res.json();
    return { fields: data.fields || {}, updateTime: data.updateTime };
}

function readArrayField(fields, key) {
    if (!fields || !fields[key]) return [];
    return parseFirestoreValue(fields[key]) || [];
}

/**
 * Read-modify-write against the shared doc, safely.
 *
 * `mutate(fields)` gets the live document fields and returns an object of top-level fields to
 * write, or null to abort without writing. The commit carries the updateTime observed at read
 * time as a precondition, so if anybody else wrote in between, Firestore rejects it and we
 * start over from a fresh read instead of clobbering them. updateMask means only the named
 * fields are touched -- everything else in the document is left exactly as it was.
 */
async function updateSharedFields(mutate, attempts = 4) {
    let lastConflict = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const snap = await fetchDocSnapshot();
        const result = mutate(snap.fields);
        if (!result || !result.payload) return { ok: true, skipped: true, reason: result && result.reason };

        const fields = {};
        Object.keys(result.payload).forEach(k => { fields[k] = toFirestoreValue(result.payload[k]); });

        const res = await fetch(FIRESTORE_COMMIT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                writes: [{
                    update: { name: FIRESTORE_DOC_NAME, fields },
                    updateMask: { fieldPaths: Object.keys(result.payload) },
                    currentDocument: { updateTime: snap.updateTime }
                }]
            })
        });

        if (res.ok) return { ok: true, info: result.info };

        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch (err) { detail = `HTTP ${res.status}`; }

        // Somebody committed between our read and our write. That is the precondition doing
        // its job -- re-read and reapply rather than forcing the write through.
        if (/FAILED_PRECONDITION|ABORTED/i.test(detail) || res.status === 409) {
            lastConflict = detail;
            continue;
        }
        if (res.status === 401 || res.status === 403) {
            throw new Error('Firestore rejected the write (permission denied). The tracker document allows writes from the app, so if this appears, check the project\'s security rules.');
        }
        throw new Error(`Firestore write failed: ${detail}`);
    }
    return { ok: false, conflict: true, detail: lastConflict };
}

/* --- Call line operations. These mirror the rules enforced in index.html; the two cannot
   share code (no bundler, different runtimes), so the invariants are restated here:
   one open session per agent, capacity is never exceeded, switching closes the previous
   session, and going Away closes the session AND drops floor availability. --- */

function openSessionsFor(sessions) {
    return sessions.filter(s => s && !s.checkOutAt);
}

function extLineSessionDuration(s, nowMs) {
    const start = new Date(s.checkInAt).getTime();
    if (isNaN(start)) return 0;
    const end = s.checkOutAt ? new Date(s.checkOutAt).getTime() : (nowMs || Date.now());
    return Math.max(0, end - start);
}

function extCloseSession(s, whenIso, byEmail, reason) {
    return {
        ...s,
        checkOutAt: whenIso,
        checkOutBy: byEmail || '',
        durationMs: extLineSessionDuration({ ...s, checkOutAt: whenIso }),
        endedReason: reason || 'manual'
    };
}

function newSessionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'ext-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

async function lineCheckIn(agentId, agentName, lineId) {
    const nowIso = new Date().toISOString();
    return updateSharedFields(fields => {
        const lines = readArrayField(fields, 'lines');
        const sessions = readArrayField(fields, 'lineSessions');
        const line = lines.find(l => l.id === lineId);
        if (!line) return { payload: null, reason: 'That line no longer exists.' };
        if (line.isActive === false) return { payload: null, reason: `${line.name} is closed for check-in.` };

        const open = openSessionsFor(sessions);
        const mine = open.find(s => s.agentId === agentId);
        if (mine && mine.lineId === lineId) return { payload: null, reason: `You are already on ${line.name}.` };

        const occupants = open.filter(s => s.lineId === lineId).length;
        if (line.capacity && occupants >= line.capacity) {
            return { payload: null, reason: `${line.name} is full (${occupants}/${line.capacity}).` };
        }

        let next = sessions;
        if (mine) next = next.map(s => (s.id === mine.id ? extCloseSession(s, nowIso, '', 'switch') : s));
        next = next.concat([{
            id: newSessionId(),
            lineId: line.id,
            lineName: line.name,
            agentId,
            agentName,
            userEmail: '',
            checkInAt: nowIso,
            checkInBy: '',
            checkOutAt: null,
            checkOutBy: '',
            durationMs: 0,
            endedReason: ''
        }]);
        return { payload: { lineSessions: next }, info: { lineName: line.name, switched: mine ? mine.lineName : null } };
    });
}

async function lineCheckOut(agentId) {
    const nowIso = new Date().toISOString();
    return updateSharedFields(fields => {
        const sessions = readArrayField(fields, 'lineSessions');
        const mine = openSessionsFor(sessions).find(s => s.agentId === agentId);
        if (!mine) return { payload: null, reason: 'You are not checked in to a line.' };
        const closed = extCloseSession(mine, nowIso, '', 'manual');
        return {
            payload: { lineSessions: sessions.map(s => (s.id === mine.id ? closed : s)) },
            info: { lineName: mine.lineName, durationMs: closed.durationMs }
        };
    });
}

// Away has to move two things at once: close the line session (or break time is counted as
// time on calls) and clear floor availability (or tickets keep being assigned to someone who
// has stepped away). Both live in one commit so they can never end up half-applied.
async function setPresence(agentId, away) {
    const nowIso = new Date().toISOString();
    return updateSharedFields(fields => {
        const agents = readArrayField(fields, 'agents');
        const sessions = readArrayField(fields, 'lineSessions');
        const agent = agents.find(a => a.id === agentId);
        if (!agent) return { payload: null, reason: 'Your agent record was not found.' };

        let nextSessions = sessions;
        let closedLineName = null;
        let closedLineId = null;
        let resumeLineId = null;

        if (away) {
            const mine = openSessionsFor(sessions).find(s => s.agentId === agentId);
            if (mine) {
                closedLineName = mine.lineName;
                closedLineId = mine.lineId;
                nextSessions = sessions.map(s => (s.id === mine.id ? extCloseSession(s, nowIso, '', 'break') : s));
            }
        } else {
            // Captured before the field is cleared below, so the caller can put them back.
            resumeLineId = agent.awayFromLineId || null;
        }

        const nextAgents = agents.map(a => {
            if (a.id !== agentId) return a;
            const updated = { ...a, presence: away ? 'away' : 'in', presenceSince: nowIso, isAvailable: !away };
            if (away) {
                // Only overwrite when they were actually on a line, so pressing Away twice
                // doesn't erase where they came from.
                if (closedLineId) updated.awayFromLineId = closedLineId;
            } else {
                updated.awayFromLineId = '';
            }
            return updated;
        });

        const payload = { agents: nextAgents };
        if (nextSessions !== sessions) payload.lineSessions = nextSessions;
        return { payload, info: { closedLineName, resumeLineId } };
    });
}
