const elIdentityLine = document.getElementById('identity-line');
const elSetup = document.getElementById('setup');
const elMain = document.getElementById('main');
const elList = document.getElementById('list');
const elSummary = document.getElementById('summary');

document.getElementById('btn-setup').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('btn-refresh').addEventListener('click', () => loadAndRender(true));

function relativeTime(date) {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function renderTickets(myTickets) {
    elList.innerHTML = '';
    if (myTickets.length === 0) {
        elList.innerHTML = '<div class="empty">No tickets assigned yet.</div>';
        elSummary.textContent = '';
        return;
    }

    const pending = myTickets.filter(t => !t.irSent).length;
    elSummary.textContent = pending > 0 ? `${pending} awaiting IR` : 'All caught up';

    myTickets.slice(0, 20).forEach(t => {
        const row = document.createElement('div');
        row.className = 'row';

        const dot = document.createElement('span');
        dot.className = `dot ${t.irSent ? 'green' : 'red'}`;

        const a = document.createElement('a');
        a.href = t.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `#${ticketRef(t)}`;
        a.title = t.link;

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = relativeTime(parseTicketTimestamp(t));

        row.appendChild(dot);
        row.appendChild(a);
        row.appendChild(time);
        elList.appendChild(row);
    });
}

async function loadAndRender(forceFresh) {
    const { agentId, agentName, myTickets: cached } = await chrome.storage.local.get(['agentId', 'agentName', 'myTickets']);

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
        renderTickets(cached);
    }

    try {
        const { tickets } = await fetchState();
        const myTickets = tickets
            .filter(t => t.agentId === agentId)
            .sort((a, b) => parseTicketTimestamp(b) - parseTicketTimestamp(a));
        renderTickets(myTickets);
        chrome.storage.local.set({ myTickets });
    } catch (err) {
        if (!Array.isArray(cached)) {
            elList.innerHTML = '<div class="empty">Couldn\'t load tickets — check your connection.</div>';
        }
        console.error('Tracker Notifier popup: fetch failed', err);
    }
}

loadAndRender(false);
