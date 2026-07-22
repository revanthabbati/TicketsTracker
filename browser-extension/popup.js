const elIdentityLine = document.getElementById('identity-line');
const elSetup = document.getElementById('setup');
const elMain = document.getElementById('main');
const elList = document.getElementById('list');
const elSummary = document.getElementById('summary');

document.getElementById('btn-setup').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('btn-refresh').addEventListener('click', () => loadAndRender(true));
document.getElementById('btn-mark-all-read').addEventListener('click', markAllVisibleRead);

let currentTickets = [];

function relativeTime(date) {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function renderTickets(myTickets, readTicketIds) {
    currentTickets = myTickets;
    elList.innerHTML = '';

    if (myTickets.length === 0) {
        elList.innerHTML = '<div class="empty">No tickets assigned yet.</div>';
        elSummary.textContent = '';
        return;
    }

    const readSet = new Set(readTicketIds);
    const unreadCount = myTickets.filter(t => !readSet.has(t.id)).length;
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

async function markAllVisibleRead() {
    const ids = currentTickets.slice(0, 20).map(t => t.id);
    const updated = await markTicketsRead(ids);
    renderTickets(currentTickets, updated);
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
}

loadAndRender(false);
