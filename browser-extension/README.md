# Tickets Assignment Tracker Notifier

A small local browser extension that notifies you when a ticket gets assigned to you in the [Tickets Assignment Tracker](../index.html), since there's no Slack bot for that yet. It shows a desktop notification and a colored badge on the toolbar icon:

- 🔴 **Red** — assigned, initial response (IR) not sent yet
- 🟢 **Green** — IR already sent

It reads the same shared Firestore document the tracker app itself uses (read-only, no changes are made to your data).

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `browser-extension` folder.
5. A setup tab opens automatically — pick your name from the dropdown and click **Save**.

That's it. You'll get a notification whenever a new ticket is assigned to you, and the toolbar icon's badge shows how many of your currently-tracked tickets are still waiting on an IR (red) or a checkmark if you're all caught up (green). Click the toolbar icon any time to see your recent assignments.

## Known limitation

The red/green status reflects the tracker app's own `irSent` field, which is only set when someone uses the app's **Send IR** button (in the Zendesk Queue tab). If a ticket was assigned through any other flow (Zendesk Queue's plain **Assign** button, or the Dashboard/CSE/CSM/Management manual-link forms) and the agent replies directly in Zendesk instead of using **Send IR**, this extension has no way to know that happened — it'll keep showing red for that ticket. This was a deliberate simplicity tradeoff, not an oversight.

## Changing your identity

Open the extension's options page again (right-click the toolbar icon → **Options**, or `chrome://extensions` → this extension → **Details** → **Extension options**) and pick a different name. Switching identities resets what counts as "already seen" so you won't get a flood of notifications for the new person's entire ticket history.

## Files

- `manifest.json` — extension manifest (Manifest V3)
- `firestore.js` — shared helper for reading the tracker's Firestore doc (used by all three contexts below)
- `background.js` — service worker: polls every minute via `chrome.alarms`, fires notifications, updates the badge
- `popup.html` / `popup.js` — toolbar popup: your recent assignments
- `options.html` / `options.js` — setup page: pick your name
- `icons/` — generated PNG icons (brand purple for the toolbar icon, red/green dots for notifications)
