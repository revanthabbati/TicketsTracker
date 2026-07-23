importScripts('firestore.js');

const ALARM_NAME = 'pollTickets';
const UNASSIGNED_ALARM_NAME = 'pollUnassigned';
const UNASSIGNED_NOTIFICATION_ID = 'unassigned-alert';
const TRACKER_APP_URL = 'https://revanthabbati.github.io/TicketsTracker/';
const MAX_INDIVIDUAL_NOTIFICATIONS = 5;
const MAX_KNOWN_IDS = 300;

chrome.runtime.onInstalled.addListener((details) => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    chrome.alarms.create(UNASSIGNED_ALARM_NAME, { periodInMinutes: 5 });
    checkForNewAssignments();
    checkUnassignedQueue();
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

chrome.runtime.onStartup.addListener(() => {
    checkForNewAssignments();
    checkUnassignedQueue();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) checkForNewAssignments();
    if (alarm.name === UNASSIGNED_ALARM_NAME) checkUnassignedQueue();
});

chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'pollNow') checkForNewAssignments();
});

// MV3 service workers have no Audio API of their own -- play sounds via a
// hidden offscreen document instead (created on demand, left open between
// alerts since there's no meaningful cost to that).
async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a short alert sound when a ticket is assigned or the queue has unassigned tickets.'
    });
}

async function maybePlayAlertSound() {
    try {
        const { soundEnabled, soundChoice } = await chrome.storage.local.get(['soundEnabled', 'soundChoice']);
        if (soundEnabled === false) return; // enabled by default until explicitly turned off
        const sound = soundChoice || 'chime';
        if (sound === 'none') return;

        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({ type: 'playSound', sound });
    } catch (err) {
        console.error('Tracker Notifier: failed to play alert sound', err);
    }
}

// Clicking a per-ticket notification opens the ticket AND marks it read --
// you clearly just looked at it. Summary notifications (>5 new at once) have
// no single ticket to open or mark, so just dismiss. The unassigned-queue
// alert opens the tracker app itself (its Zendesk Queue tab), since it's not
// about any one ticket.
chrome.notifications.onClicked.addListener(async (notificationId) => {
    chrome.notifications.clear(notificationId);

    if (notificationId === UNASSIGNED_NOTIFICATION_ID) {
        chrome.tabs.create({ url: TRACKER_APP_URL });
        return;
    }
    if (!notificationId.startsWith('ticket-')) return;

    const ticketId = notificationId.slice('ticket-'.length);
    const { myTickets = [] } = await chrome.storage.local.get('myTickets');
    const ticket = myTickets.find(t => t.id === ticketId);
    if (ticket) chrome.tabs.create({ url: ticket.link });
    await markTicketsRead([ticketId]);
});

// Independent of per-agent identity -- an empty Zendesk Queue matters to
// whoever's watching, not just one person, so this runs regardless of whether
// the extension's own agent identity has been configured yet.
async function checkUnassignedQueue() {
    try {
        const { settings } = await fetchState();
        const zendesk = settings && settings.zendesk;
        if (!zendesk) return;

        const unassignedTickets = await fetchUnassignedTickets(zendesk);
        await chrome.storage.local.set({ unassignedTickets, unassignedSubdomain: zendesk.subdomain });

        const count = unassignedTickets.length;
        if (count > 0) {
            chrome.notifications.create(UNASSIGNED_NOTIFICATION_ID, {
                type: 'basic',
                iconUrl: 'icons/notify-red.png',
                title: 'Unassigned tickets waiting',
                message: `${count} ticket${count === 1 ? '' : 's'} in the Zendesk queue ${count === 1 ? 'has' : 'have'} no assignee yet.`
            });
            maybePlayAlertSound();
        } else {
            chrome.notifications.clear(UNASSIGNED_NOTIFICATION_ID);
        }
    } catch (err) {
        console.error('Tracker Notifier: unassigned queue check failed', err);
    }
}

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
        maybePlayAlertSound();
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
    maybePlayAlertSound();
}
