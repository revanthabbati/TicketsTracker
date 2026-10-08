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
    if (message && message.type === 'testSound' && message.sound) {
        playSound(message.sound, message.volume).catch(err => console.error('Tracker Notifier: test sound failed', err));
    }
});

// MV3 service workers have no Audio API of their own -- play sounds via a
// hidden offscreen document instead (created on demand, left open between
// alerts since there's no meaningful cost to that). If the document doesn't
// exist yet, the sound is passed via the document's URL instead of a runtime
// message, since a message sent immediately after createDocument() resolves
// can otherwise race the document's own script still loading (see offscreen.js).
async function playSound(soundName, volume) {
    // Only the choice id and the volume cross this boundary; the offscreen document
    // reads an uploaded sound's audio out of storage itself (see offscreen.js).
    const vol = typeof volume === 'number' ? volume : 1;
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
        chrome.runtime.sendMessage({ type: 'playSound', sound: soundName, volume: vol });
    } else {
        await chrome.offscreen.createDocument({
            url: `offscreen.html?sound=${encodeURIComponent(soundName)}&volume=${encodeURIComponent(vol)}`,
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'Play a short alert sound when a ticket is assigned or the queue has unassigned tickets.'
        });
    }
}

async function maybePlayAlertSound() {
    try {
        const { soundEnabled, soundChoice, soundVolume } = await chrome.storage.local.get(['soundEnabled', 'soundChoice', 'soundVolume']);
        if (soundEnabled === false) return; // enabled by default until explicitly turned off
        const sound = soundChoice || 'chime';
        if (sound === 'none') return;

        // Full volume until someone moves the slider, so an upgrade never makes
        // existing alerts quieter than they were.
        await playSound(sound, typeof soundVolume === 'number' ? soundVolume : 1);
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

        const state = await fetchState();
        const { tickets, settings } = state;

        // Placed here, before any of the early returns below, so the roster warning still
        // fires on the very first poll after setup.
        await checkRosterDuty(state);

        const myTickets = tickets
            .filter(t => t.agentId === agentId)
            .sort((a, b) => parseTicketTimestamp(b) - parseTicketTimestamp(a));

        await enrichWithSubjects(myTickets, settings && settings.zendesk);

        // First run for this identity: seed known ids without notifying, so a
        // fresh install (or switching to a different agent) doesn't fire one
        // notification per pre-existing ticket.
        if (!Array.isArray(knownTicketIds)) {
            await chrome.storage.local.set({ knownTicketIds: myTickets.map(t => t.id) });
            try { await chrome.storage.local.set({ myTickets }); } catch (err) { /* cache only */ }
            applyBadge(computeBadge(myTickets, readTicketIds));
            return;
        }

        // One-time repair. The truncation bug below dropped currently-assigned tickets out of
        // knownTicketIds, so anyone affected has a list that wrongly says their whole backlog
        // is new. Re-seed it once, silently, exactly as a first run would -- otherwise the fix
        // itself would deliver one last flood on the way to behaving. The badge still shows
        // anything genuinely unread, so nothing is lost by not notifying for this one poll.
        const { knownIdsRepaired } = await chrome.storage.local.get('knownIdsRepaired');
        if (!knownIdsRepaired) {
            const repaired = Array.from(new Set([...myTickets.map(t => t.id), ...knownTicketIds]));
            await chrome.storage.local.set({ knownTicketIds: repaired, knownIdsRepaired: true });
            try { await chrome.storage.local.set({ myTickets }); } catch (err) { /* cache only */ }
            applyBadge(computeBadge(myTickets, readTicketIds));
            return;
        }

        const knownSet = new Set(knownTicketIds);
        const readSet = new Set(readTicketIds || []);
        // A ticket you have already read is never new, whatever knownTicketIds says. This is
        // a backstop rather than the primary guard: if that list is ever lost or truncated,
        // the worst case becomes a silent re-notify of genuinely unread work, instead of the
        // whole backlog arriving again every minute.
        const newOnes = myTickets.filter(t => !knownSet.has(t.id) && !readSet.has(t.id));

        if (newOnes.length > 0) {
            notifyNewAssignments(newOnes);
        }

        // Every ticket currently assigned must be remembered, or it looks new again on the
        // next poll. The old line took the LAST n of [known..., current...]; since myTickets
        // is sorted newest-first, that tail was the OLDEST of them -- so once somebody passed
        // n tickets their newest ones dropped out of the list and re-notified every minute.
        // Current ids now come first and the cap can only ever discard older history.
        const currentIds = myTickets.map(t => t.id);
        const currentSet = new Set(currentIds);
        const history = knownTicketIds.filter(id => !currentSet.has(id));
        const updatedKnown = [...currentIds, ...history].slice(0, Math.max(MAX_KNOWN_IDS, currentIds.length));

        // Written on its own, and first: it is a few KB and it is what stops duplicate
        // notifications. myTickets is only a render cache, and bundling the two meant a
        // failure saving the cache (a full storage quota, say) also lost the ids.
        await chrome.storage.local.set({ knownTicketIds: updatedKnown });
        try {
            await chrome.storage.local.set({ myTickets });
        } catch (err) {
            console.warn('Tracker Notifier: could not cache tickets for the popup', err);
        }
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

// Warns an agent shortly before their rostered block starts, so they can be on the line at
// the top of the hour instead of noticing late. Runs on the existing one-minute alarm --
// no extra polling, since checkForNewAssignments already fetches the same document.
async function checkRosterDuty(state) {
    try {
        const { agentId, rosterAlertsEnabled, lastRosterAlertKey } = await chrome.storage.local.get(
            ['agentId', 'rosterAlertsEnabled', 'lastRosterAlertKey']);
        if (!agentId) return;
        if (rosterAlertsEnabled === false) return;   // on by default until turned off

        const duty = upcomingRosterDuty(state, agentId, new Date(), ROSTER_ALERT_LEAD_MINUTES);
        if (!duty) return;
        // One alert per block. The one-minute alarm would otherwise fire this five times.
        if (lastRosterAlertKey === duty.key) return;

        await chrome.storage.local.set({ lastRosterAlertKey: duty.key });

        const when = duty.minutesUntil <= 0 ? 'now'
            : duty.minutesUntil === 1 ? 'in 1 minute'
            : `in ${duty.minutesUntil} minutes`;
        chrome.notifications.create(`roster-${duty.key}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `You're on ${duty.lineName} ${when}`,
            message: `${duty.slotLabel} starts at ${duty.start}. Check in on the Calls tab when you take the line.`
        });
        maybePlayAlertSound();
    } catch (err) {
        console.error('Tracker Notifier: roster check failed', err);
    }
}
