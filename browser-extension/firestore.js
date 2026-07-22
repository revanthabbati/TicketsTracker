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

// Fetches the tracker's shared state doc and returns plain { tickets, agents }
// arrays. Throws on any network/HTTP failure -- callers decide how to handle it.
async function fetchState() {
    const res = await fetch(FIRESTORE_DOC_URL);
    if (!res.ok) throw new Error(`Firestore returned ${res.status}`);
    const data = await res.json();
    const fields = data.fields || {};
    return {
        tickets: parseFirestoreFields(fields, 'tickets'),
        agents: parseFirestoreFields(fields, 'agents')
    };
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
