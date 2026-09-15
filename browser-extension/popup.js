const elIdentityLine = document.getElementById('identity-line');
const elSetup = document.getElementById('setup');
const elMain = document.getElementById('main');
const elList = document.getElementById('list');
const elSummary = document.getElementById('summary');
const elMineCount = document.getElementById('mine-count');
const elUnassignedList = document.getElementById('unassigned-list');
const elUnassignedSummary = document.getElementById('unassigned-summary');
const elUnassignedCount = document.getElementById('unassigned-count');
const elPanelMine = document.getElementById('panel-mine');
const elPanelUnassigned = document.getElementById('panel-unassigned');

document.getElementById('btn-setup').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('btn-refresh').addEventListener('click', () => loadAndRender(true));
document.getElementById('btn-mark-all-read').addEventListener('click', markAllRead);
document.getElementById('btn-refresh-unassigned').addEventListener('click', () => loadUnassigned(true));
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

let currentTickets = [];
let currentUnassigned = [];
let currentAgentId = null;
let currentAgentName = '';

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    elPanelMine.classList.toggle('hidden', tab !== 'mine');
    elPanelUnassigned.classList.toggle('hidden', tab !== 'unassigned');
    document.getElementById('panel-calls').classList.toggle('hidden', tab !== 'calls');
    if (tab === 'unassigned' && currentUnassigned.length === 0) {
        loadUnassigned(false);
    }
    // Always re-read on open: the board is shared, and a stale seat count would let someone
    // check in to a line that filled up while the popup was closed.
    if (tab === 'calls') {
        loadCalls(true);
    }
}

function relativeTime(date) {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function setTabCount(el, count, red) {
    el.textContent = String(count);
    el.classList.toggle('hidden', count === 0);
    el.classList.toggle('red', !!red);
}

function renderTickets(myTickets, readTicketIds) {
    currentTickets = myTickets;
    elList.innerHTML = '';

    const readSet = new Set(readTicketIds);
    const unreadCount = myTickets.filter(t => !readSet.has(t.id)).length;
    setTabCount(elMineCount, unreadCount, unreadCount > 0);

    if (myTickets.length === 0) {
        elList.innerHTML = '<div class="empty">No tickets assigned yet.</div>';
        elSummary.textContent = '';
        return;
    }

    elSummary.textContent = unreadCount > 0 ? `${unreadCount} unread` : 'All caught up';

    myTickets.slice(0, 20).forEach(t => {
        const isRead = readSet.has(t.id);

        const row = document.createElement('div');
        row.className = `row${isRead ? ' read' : ''}`;

        const top = document.createElement('div');
        top.className = 'row-top';

        const dot = document.createElement('span');
        dot.className = `dot ${t.irSent ? 'green' : 'red'}`;

        const a = document.createElement('a');
        a.className = 'ticket-link';
        a.href = t.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `#${ticketRef(t)}`;
        a.title = t.link;
        a.addEventListener('click', () => markRead(t.id));

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = relativeTime(parseTicketTimestamp(t));

        const markBtn = document.createElement('button');
        markBtn.className = 'mark-btn';
        markBtn.textContent = isRead ? 'Unread' : 'Read';
        markBtn.addEventListener('click', () => (isRead ? markUnread(t.id) : markRead(t.id)));

        top.appendChild(dot);
        top.appendChild(a);
        top.appendChild(time);
        top.appendChild(markBtn);
        row.appendChild(top);

        const subject = document.createElement('div');
        subject.className = 'subject';
        subject.textContent = t.subject || '(no subject)';
        row.appendChild(subject);

        elList.appendChild(row);
    });
}

async function markRead(ticketId) {
    const updated = await markTicketsRead([ticketId]);
    renderTickets(currentTickets, updated);
}

async function markUnread(ticketId) {
    const updated = await markTicketsUnread([ticketId]);
    renderTickets(currentTickets, updated);
}

async function markAllRead() {
    // currentTickets already holds the full per-agent list -- only the
    // rendered rows are capped at 20, so this must not re-slice it, or the
    // badge/unread count could never reach zero for anyone with more than
    // 20 tickets.
    const ids = currentTickets.map(t => t.id);
    const updated = await markTicketsRead(ids);
    renderTickets(currentTickets, updated);
}

function renderUnassigned(tickets, subdomain) {
    currentUnassigned = tickets;
    elUnassignedList.innerHTML = '';
    setTabCount(elUnassignedCount, tickets.length, tickets.length > 0);

    if (tickets.length === 0) {
        elUnassignedList.innerHTML = '<div class="empty">No unassigned tickets right now.</div>';
        elUnassignedSummary.textContent = '';
        return;
    }

    elUnassignedSummary.textContent = `${tickets.length} unassigned`;

    tickets.forEach(t => {
        const row = document.createElement('div');
        row.className = 'row';

        const top = document.createElement('div');
        top.className = 'row-top';

        const priority = document.createElement('span');
        priority.className = `priority-tag ${(t.priority || 'normal').toLowerCase()}`;
        priority.textContent = t.priority || 'normal';

        const a = document.createElement('a');
        a.className = 'ticket-link';
        a.href = subdomain ? `https://${subdomain}.zendesk.com/agent/tickets/${t.id}` : '#';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `#${t.id}`;

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = relativeTime(new Date(t.created_at));

        top.appendChild(priority);
        top.appendChild(a);
        top.appendChild(time);
        row.appendChild(top);

        const subject = document.createElement('div');
        subject.className = 'subject';
        subject.textContent = t.subject || '(no subject)';
        row.appendChild(subject);

        elUnassignedList.appendChild(row);
    });
}

async function loadUnassigned(forceFresh) {
    const { unassignedTickets: cached, unassignedSubdomain: cachedSubdomain } = await chrome.storage.local.get(['unassignedTickets', 'unassignedSubdomain']);

    let zendesk = null;
    try {
        const { settings } = await fetchState();
        zendesk = settings && settings.zendesk;
    } catch (err) {
        console.error('Tracker Notifier popup: failed to load settings', err);
    }
    const subdomain = (zendesk && zendesk.subdomain) || cachedSubdomain;

    if (Array.isArray(cached) && !forceFresh) {
        renderUnassigned(cached, subdomain);
    } else {
        elUnassignedSummary.textContent = 'Loading…';
    }

    if (!zendesk) {
        if (!Array.isArray(cached)) elUnassignedList.innerHTML = '<div class="empty">Zendesk isn\'t configured yet.</div>';
        return;
    }

    try {
        const tickets = await fetchUnassignedTickets(zendesk);
        renderUnassigned(tickets, subdomain);
        chrome.storage.local.set({ unassignedTickets: tickets, unassignedSubdomain: subdomain });
    } catch (err) {
        if (!Array.isArray(cached)) {
            elUnassignedList.innerHTML = '<div class="empty">Couldn\'t load the queue — check your connection.</div>';
        }
        console.error('Tracker Notifier popup: unassigned fetch failed', err);
    }
}

async function loadAndRender(forceFresh) {
    const { agentId, agentName, myTickets: cached, readTicketIds = [] } = await chrome.storage.local.get(['agentId', 'agentName', 'myTickets', 'readTicketIds']);

    if (!agentId) {
        elSetup.classList.remove('hidden');
        elMain.classList.add('hidden');
        elIdentityLine.textContent = 'Not set up';
        return;
    }

    elSetup.classList.add('hidden');
    elMain.classList.remove('hidden');
    elIdentityLine.textContent = `Signed in as ${agentName}`;

    // The Calls tab acts as this agent, so it needs the identity the options page saved.
    currentAgentId = agentId;
    currentAgentName = agentName;

    if (Array.isArray(cached) && !forceFresh) {
        renderTickets(cached, readTicketIds);
    }

    try {
        const { tickets, settings } = await fetchState();
        const myTickets = tickets
            .filter(t => t.agentId === agentId)
            .sort((a, b) => parseTicketTimestamp(b) - parseTicketTimestamp(a));
        await enrichWithSubjects(myTickets, settings && settings.zendesk);
        renderTickets(myTickets, readTicketIds);
        chrome.storage.local.set({ myTickets });
    } catch (err) {
        if (!Array.isArray(cached)) {
            elList.innerHTML = '<div class="empty">Couldn\'t load tickets — check your connection.</div>';
        }
        console.error('Tracker Notifier popup: fetch failed', err);
    }

    // The unassigned tab has its own cache from background.js's periodic poll,
    // so show that instantly regardless of which tab is active on open.
    const { unassignedTickets: cachedUnassigned } = await chrome.storage.local.get('unassignedTickets');
    if (Array.isArray(cachedUnassigned)) {
        setTabCount(elUnassignedCount, cachedUnassigned.length, cachedUnassigned.length > 0);
    }
}

loadAndRender(false);

/* --- Calls tab: check in/out of a line and set yourself Away, from the popup --- */

const elCallStatusLabel = document.getElementById('call-status-label');
const elCallStatusMain = document.getElementById('call-status-main');
const elCallStatusSub = document.getElementById('call-status-sub');
const elCallLineSelect = document.getElementById('call-line-select');
const elCallMessage = document.getElementById('call-message');
const elCallBoard = document.getElementById('call-board');
const elCallsCount = document.getElementById('calls-count');
const elBtnCheckIn = document.getElementById('btn-call-checkin');
const elBtnCheckOut = document.getElementById('btn-call-checkout');
const elBtnPresence = document.getElementById('btn-call-presence');
const elPanelCalls = document.getElementById('panel-calls');

let callState = null;     // { lines, lineSessions, agents }
let callTicker = null;
let callBusy = false;

document.getElementById('btn-call-refresh').addEventListener('click', () => loadCalls(true));
elBtnCheckIn.addEventListener('click', doCheckIn);
elBtnCheckOut.addEventListener('click', doCheckOut);
elBtnPresence.addEventListener('click', doTogglePresence);

function callMessage(text, kind) {
    elCallMessage.textContent = text || '';
    elCallMessage.className = kind || '';
}

function formatCallDuration(ms) {
    const total = Math.floor(Math.max(0, ms || 0) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}

function myOpenCallSession() {
    if (!callState) return null;
    return callState.lineSessions.find(s => s && !s.checkOutAt && s.agentId === currentAgentId) || null;
}

function myCallAgent() {
    if (!callState) return null;
    return callState.agents.find(a => a.id === currentAgentId) || null;
}

function amAway() {
    const a = myCallAgent();
    // Mirrors the app: Away only counts while actually off the floor, so anything that puts
    // the agent back on (a manager's toggle, the shift evaluator) clears it here too.
    return !!a && a.presence === 'away' && a.isAvailable === false;
}

async function loadCalls(force) {
    if (!currentAgentId) return;
    if (!force && callState) { renderCalls(); return; }
    callMessage('Loading…');
    try {
        const state = await fetchState();
        callState = { lines: state.lines || [], lineSessions: state.lineSessions || [], agents: state.agents || [] };
        callMessage('');
        renderCalls();
    } catch (err) {
        console.error('Tracker Notifier: failed to load call lines', err);
        callMessage('Could not reach the tracker. Check your connection.', 'error');
    }
}

function renderCalls() {
    if (!callState) return;
    const mine = myOpenCallSession();
    const away = amAway();
    const agent = myCallAgent();

    // Status block
    if (away) {
        elCallStatusLabel.className = 'call-status-label away';
        elCallStatusLabel.textContent = 'Away';
        elCallStatusMain.textContent = agent && agent.presenceSince
            ? formatCallDuration(Date.now() - new Date(agent.presenceSince).getTime())
            : '—';
        elCallStatusSub.textContent = 'Off the floor — no new tickets will be assigned to you.';
    } else if (mine) {
        elCallStatusLabel.className = 'call-status-label';
        elCallStatusLabel.textContent = `On ${mine.lineName}`;
        elCallStatusMain.textContent = formatCallDuration(Date.now() - new Date(mine.checkInAt).getTime());
        elCallStatusSub.textContent = `Checked in ${new Date(mine.checkInAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
        elCallStatusLabel.className = 'call-status-label off';
        elCallStatusLabel.textContent = 'Not on a line';
        elCallStatusMain.textContent = currentAgentName || '';
        elCallStatusSub.textContent = agent ? 'Available for tickets.' : 'Your agent record was not found.';
    }

    setTabCount(elCallsCount, mine ? 1 : 0, false);

    // Line picker: only lines open for check-in, and not the one already occupied.
    const selectable = callState.lines.filter(l => {
        if (l.isActive === false) return false;
        if (mine && l.id === mine.lineId) return false;
        if (!l.capacity) return true;
        return callState.lineSessions.filter(s => !s.checkOutAt && s.lineId === l.id).length < l.capacity;
    });
    const keep = elCallLineSelect.value;
    elCallLineSelect.innerHTML = '';
    if (selectable.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = callState.lines.length ? 'No line available' : 'No lines set up yet';
        elCallLineSelect.appendChild(opt);
    } else {
        selectable.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.id;
            const used = callState.lineSessions.filter(s => !s.checkOutAt && s.lineId === l.id).length;
            opt.textContent = l.capacity ? `${l.name} (${used}/${l.capacity})` : l.name;
            elCallLineSelect.appendChild(opt);
        });
        if (selectable.some(l => l.id === keep)) elCallLineSelect.value = keep;
    }

    elBtnCheckIn.textContent = mine ? 'Move to this line' : 'Check In';
    elBtnCheckIn.disabled = callBusy || away || selectable.length === 0;
    elBtnCheckOut.classList.toggle('hidden', !mine);
    elBtnCheckOut.disabled = callBusy;
    elBtnPresence.textContent = away ? 'I’m Back' : 'Set Away';
    elBtnPresence.className = away ? 'call-away-on' : '';
    elBtnPresence.disabled = callBusy || !agent;
    elCallLineSelect.disabled = away;

    renderCallBoard();
    startCallTicker();
}

function renderCallBoard() {
    elCallBoard.innerHTML = '';
    if (!callState || callState.lines.length === 0) return;

    const sorted = callState.lines.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    sorted.forEach(line => {
        const occupants = callState.lineSessions
            .filter(s => !s.checkOutAt && s.lineId === line.id)
            .sort((a, b) => new Date(a.checkInAt) - new Date(b.checkInAt));

        const row = document.createElement('div');
        row.className = 'call-line-row';

        const head = document.createElement('div');
        head.className = 'call-line-head';
        const name = document.createElement('span');
        name.className = 'call-line-name';
        name.textContent = line.name;
        const cap = document.createElement('span');
        cap.className = 'call-line-cap';
        cap.textContent = line.isActive === false ? 'closed' : `${occupants.length}${line.capacity ? ` / ${line.capacity}` : ''}`;
        head.appendChild(name);
        head.appendChild(cap);
        row.appendChild(head);

        const people = document.createElement('div');
        people.className = 'call-line-people';
        if (occupants.length === 0) {
            people.textContent = 'Nobody on this line';
        } else {
            occupants.forEach((s, i) => {
                if (i > 0) people.appendChild(document.createTextNode(', '));
                const span = document.createElement('span');
                if (s.agentId === currentAgentId) span.className = 'me';
                span.textContent = `${s.agentName} (${formatCallDuration(Date.now() - new Date(s.checkInAt).getTime())})`;
                people.appendChild(span);
            });
        }
        row.appendChild(people);
        elCallBoard.appendChild(row);
    });

    const awayAgents = callState.agents.filter(a => a.presence === 'away' && a.isAvailable === false);
    if (awayAgents.length > 0) {
        const row = document.createElement('div');
        row.className = 'call-line-row';
        const head = document.createElement('div');
        head.className = 'call-line-head';
        const name = document.createElement('span');
        name.className = 'call-line-name';
        name.textContent = 'On a break';
        const cap = document.createElement('span');
        cap.className = 'call-line-cap';
        cap.textContent = String(awayAgents.length);
        head.appendChild(name);
        head.appendChild(cap);
        row.appendChild(head);
        const people = document.createElement('div');
        people.className = 'call-line-people';
        people.textContent = awayAgents.map(a => a.name).join(', ');
        row.appendChild(people);
        elCallBoard.appendChild(row);
    }
}

// The popup is short-lived, so this only runs while it is actually open.
function startCallTicker() {
    if (callTicker) return;
    callTicker = setInterval(() => {
        if (elPanelCalls.classList.contains('hidden')) return;
        if (!callState) return;
        const mine = myOpenCallSession();
        const agent = myCallAgent();
        if (amAway() && agent && agent.presenceSince) {
            elCallStatusMain.textContent = formatCallDuration(Date.now() - new Date(agent.presenceSince).getTime());
        } else if (mine) {
            elCallStatusMain.textContent = formatCallDuration(Date.now() - new Date(mine.checkInAt).getTime());
        }
        renderCallBoard();
    }, 1000);
}

// Every action re-reads from Firestore afterwards rather than patching local state, so what
// the popup shows is what actually committed -- including when somebody else took the last
// seat a moment earlier.
async function runCallAction(fn, pendingText) {
    if (callBusy) return;
    callBusy = true;
    renderCalls();
    callMessage(pendingText);
    try {
        const res = await fn();
        if (res && res.skipped) {
            callMessage(res.reason || 'Nothing to do.', 'error');
        } else if (res && res.conflict) {
            callMessage('Someone else was changing the board at the same time. Try again.', 'error');
        } else {
            callMessage('Done.', 'ok');
        }
    } catch (err) {
        console.error('Tracker Notifier: call action failed', err);
        callMessage(err.message || 'That did not go through.', 'error');
    } finally {
        callBusy = false;
        await loadCalls(true);
    }
}

function doCheckIn() {
    const lineId = elCallLineSelect.value;
    if (!lineId) return callMessage('Pick a line first.', 'error');
    runCallAction(() => lineCheckIn(currentAgentId, currentAgentName, lineId), 'Checking in…');
}

function doCheckOut() {
    runCallAction(() => lineCheckOut(currentAgentId), 'Checking out…');
}

function doTogglePresence() {
    const away = !amAway();
    runCallAction(async () => {
        const res = await setPresence(currentAgentId, away);
        // Coming back puts them on the line they left, matching the app. Two commits rather
        // than one because the resume has to re-check capacity against the live board -- the
        // seat may have gone while they were on break.
        if (!away && res && res.ok && res.info && res.info.resumeLineId) {
            const back = await lineCheckIn(currentAgentId, currentAgentName, res.info.resumeLineId);
            if (back && back.skipped) return { skipped: true, reason: `Back in, but not on a line: ${back.reason}` };
        }
        return res;
    }, away ? 'Setting away…' : 'Coming back…');
}
