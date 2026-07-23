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
// settings } data. Throws on any network/HTTP failure -- callers decide how
// to handle it.
async function fetchState() {
    const res = await fetch(FIRESTORE_DOC_URL);
    if (!res.ok) throw new Error(`Firestore returned ${res.status}`);
    const data = await res.json();
    const fields = data.fields || {};
    return {
        tickets: parseFirestoreFields(fields, 'tickets'),
        agents: parseFirestoreFields(fields, 'agents'),
        settings: fields.settings ? parseFirestoreValue(fields.settings) : {}
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
