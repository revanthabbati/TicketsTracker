importScripts('firestore.js');

const ALARM_NAME = 'pollTickets';
const MAX_INDIVIDUAL_NOTIFICATIONS = 5;
const MAX_KNOWN_IDS = 300;

chrome.runtime.onInstalled.addListener((details) => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    checkForNewAssignments();
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

chrome.runtime.onStartup.addListener(() => {
    checkForNewAssignments();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) checkForNewAssignments();
});

chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'pollNow') checkForNewAssignments();
});

// Clicking a per-ticket notification opens the ticket AND marks it read --
// you clearly just looked at it. Summary notifications (>5 new at once) have
// no single ticket to open or mark, so just dismiss.
chrome.notifications.onClicked.addListener(async (notificationId) => {
    chrome.notifications.clear(notificationId);
    if (!notificationId.startsWith('ticket-')) return;

    const ticketId = notificationId.slice('ticket-'.length);
    const { myTickets = [] } = await chrome.storage.local.get('myTickets');
    const ticket = myTickets.find(t => t.id === ticketId);
    if (ticket) chrome.tabs.create({ url: ticket.link });
    await markTicketsRead([ticketId]);
});

async function checkForNewAssignments() {
    try {
        const { agentId, knownTicketIds, readTicketIds } = await chrome.storage.local.get(['agentId', 'knownTicketIds', 'readTicketIds']);
        if (!agentId) {
            chrome.action.setBadgeText({ text: '' });
            return;
        }

        const { tickets, settings } = await fetchState();
        const myTickets = tickets
            .filter(t => t.agentId === agentId)
            .sort((a, b) => parseTicketTimestamp(b) - parseTicketTimestamp(a));

        await enrichWithSubjects(myTickets, settings && settings.zendesk);

        // First run for this identity: seed known ids without notifying, so a
        // fresh install (or switching to a different agent) doesn't fire one
        // notification per pre-existing ticket.
        if (!Array.isArray(knownTicketIds)) {
            await chrome.storage.local.set({
                knownTicketIds: myTickets.map(t => t.id),
                myTickets
            });
            applyBadge(computeBadge(myTickets, readTicketIds));
            return;
        }

        const knownSet = new Set(knownTicketIds);
        const newOnes = myTickets.filter(t => !knownSet.has(t.id));

        if (newOnes.length > 0) {
            notifyNewAssignments(newOnes);
        }

        const updatedKnown = Array.from(new Set([...knownTicketIds, ...myTickets.map(t => t.id)])).slice(-MAX_KNOWN_IDS);
        await chrome.storage.local.set({ knownTicketIds: updatedKnown, myTickets });
        applyBadge(computeBadge(myTickets, readTicketIds));
    } catch (err) {
        console.error('Tracker Notifier: poll failed', err);
    }
}

function notifyNewAssignments(newOnes) {
    if (newOnes.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
        chrome.notifications.create(`summary-${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'New tickets assigned',
            message: `${newOnes.length} new tickets assigned to you.`
        });
        return;
    }

    for (const t of newOnes) {
        const icon = t.irSent ? 'icons/notify-green.png' : 'icons/notify-red.png';
        const subjectLine = t.subject ? t.subject.substring(0, 80) : '(no subject)';
        const statusLine = t.irSent ? 'IR already sent' : 'IR not sent yet';
        chrome.notifications.create(`ticket-${t.id}`, {
            type: 'basic',
            iconUrl: icon,
            title: `New ticket assigned: #${ticketRef(t)}`,
            message: `${subjectLine}\n${statusLine}`
        });
    }
}
