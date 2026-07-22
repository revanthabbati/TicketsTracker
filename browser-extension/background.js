importScripts('firestore.js');

const ALARM_NAME = 'pollTickets';
const BADGE_RED = '#f43f5e';
const BADGE_GREEN = '#10b981';
const MAX_INDIVIDUAL_NOTIFICATIONS = 5;
const MAX_KNOWN_IDS = 300;
const MAX_STORED_LINKS = 100;

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

chrome.notifications.onClicked.addListener(async (notificationId) => {
    const { notificationLinks = {} } = await chrome.storage.local.get('notificationLinks');
    const link = notificationLinks[notificationId];
    if (link) chrome.tabs.create({ url: link });
    chrome.notifications.clear(notificationId);
});

async function checkForNewAssignments() {
    try {
        const { agentId, knownTicketIds } = await chrome.storage.local.get(['agentId', 'knownTicketIds']);
        if (!agentId) {
            chrome.action.setBadgeText({ text: '' });
            return;
        }

        const { tickets } = await fetchState();
        const myTickets = tickets
            .filter(t => t.agentId === agentId)
            .sort((a, b) => parseTicketTimestamp(b) - parseTicketTimestamp(a));

        // First run for this identity: seed known ids without notifying, so a
        // fresh install (or switching to a different agent) doesn't fire one
        // notification per pre-existing ticket.
        if (!Array.isArray(knownTicketIds)) {
            await chrome.storage.local.set({
                knownTicketIds: myTickets.map(t => t.id),
                myTickets
            });
            updateBadge(myTickets);
            return;
        }

        const knownSet = new Set(knownTicketIds);
        const newOnes = myTickets.filter(t => !knownSet.has(t.id));

        if (newOnes.length > 0) {
            await notifyNewAssignments(newOnes);
        }

        const updatedKnown = Array.from(new Set([...knownTicketIds, ...myTickets.map(t => t.id)])).slice(-MAX_KNOWN_IDS);
        await chrome.storage.local.set({ knownTicketIds: updatedKnown, myTickets });
        updateBadge(myTickets);
    } catch (err) {
        console.error('Tracker Notifier: poll failed', err);
    }
}

async function notifyNewAssignments(newOnes) {
    if (newOnes.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
        chrome.notifications.create(`summary-${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'New tickets assigned',
            message: `${newOnes.length} new tickets assigned to you.`
        });
        return;
    }

    const { notificationLinks = {} } = await chrome.storage.local.get('notificationLinks');

    for (const t of newOnes) {
        const id = `ticket-${t.id}`;
        const icon = t.irSent ? 'icons/notify-green.png' : 'icons/notify-red.png';
        chrome.notifications.create(id, {
            type: 'basic',
            iconUrl: icon,
            title: 'New ticket assigned',
            message: `#${ticketRef(t)} — ${t.irSent ? 'IR already sent' : 'IR not sent yet'}`
        });
        notificationLinks[id] = t.link;
    }

    // Bound storage growth -- keep only the most recently added link mappings.
    const trimmed = Object.fromEntries(Object.entries(notificationLinks).slice(-MAX_STORED_LINKS));
    await chrome.storage.local.set({ notificationLinks: trimmed });
}

function updateBadge(myTickets) {
    if (myTickets.length === 0) {
        chrome.action.setBadgeText({ text: '' });
        return;
    }
    const pending = myTickets.filter(t => !t.irSent).length;
    if (pending > 0) {
        chrome.action.setBadgeBackgroundColor({ color: BADGE_RED });
        chrome.action.setBadgeText({ text: String(Math.min(pending, 99)) });
    } else {
        chrome.action.setBadgeBackgroundColor({ color: BADGE_GREEN });
        chrome.action.setBadgeText({ text: '✓' });
    }
}
