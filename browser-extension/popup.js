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

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    elPanelMine.classList.toggle('hidden', tab !== 'mine');
    elPanelUnassigned.classList.toggle('hidden', tab !== 'unassigned');
    if (tab === 'unassigned' && currentUnassigned.length === 0) {
        loadUnassigned(false);
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
