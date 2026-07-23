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

That's it. You'll get a notification whenever a new ticket is assigned to you — with the ticket number, subject, and IR status — and the toolbar icon's badge shows how many of your assignments are still unread (red if any of them are also awaiting an IR, green checkmark once you're caught up). Click the toolbar icon any time to see your recent assignments, each with its subject line.

## My Tickets / Unassigned tabs

The popup has two tabs:
- **My Tickets** — your assignments, as above.
- **Unassigned** — a live view of Zendesk's unassigned queue (same query as the app's Zendesk Queue "Unassigned" tab). A ticket only ever appears here until someone actually assigns it in Zendesk, at which point it drops off this list and (if it was assigned to you) shows up under My Tickets instead.

## Marking tickets as read

Every assignment starts out unread. You can clear it three ways:
- Click **Read** next to a ticket in the popup
- Click the ticket link itself (opening it counts as reading it)
- Click **Mark all read** to clear everything, not just what's currently visible

Marking something read removes it from the unread count that drives the toolbar badge, but it stays in the list (dimmed) so you can still find it, or click **Unread** to put it back. This is purely local to your browser — it's never written back to the shared tracker data, so it doesn't affect anyone else or the app itself.

## Unassigned queue alert

Separately from your own assignments, this checks Zendesk every 5 minutes for tickets sitting with no assignee at all. If there are any, you'll get a notification that repeats every 5 minutes until the queue is cleared; clicking it opens the tracker app. This runs regardless of whether you've set up your name yet — it's account-wide, not personal.

## Alert sound

On by default (Chime — Ping and Bell are also available in Options, along with an off switch and a Test button). Plays whenever a new-assignment or unassigned-queue notification fires.

## Known limitation

The red/green **dot** on each ticket reflects the tracker app's own `irSent` field, which is only set when someone uses the app's **Send IR** button (in the Zendesk Queue tab). If a ticket was assigned through any other flow (Zendesk Queue's plain **Assign** button, or the Dashboard/CSE/CSM/Management manual-link forms) and the agent replies directly in Zendesk instead of using **Send IR**, this extension has no way to know that happened — the dot stays red for that ticket even after you've handled it. Marking it **read** is the way to clear it from your attention regardless. This was a deliberate simplicity tradeoff, not an oversight.

## Changing your identity or sound settings

Open the extension's options page again (right-click the toolbar icon → **Options**, or `chrome://extensions` → this extension → **Details** → **Extension options**) to pick a different name or change the alert sound. Switching identities resets what counts as "already seen" so you won't get a flood of notifications for the new person's entire ticket history.

## Files

- `manifest.json` — extension manifest (Manifest V3)
- `firestore.js` — shared helper for reading the tracker's Firestore doc, fetching ticket subjects and the unassigned queue from Zendesk, and computing read/unread + badge state (used by all contexts below)
- `background.js` — service worker: polls your assignments every minute and the unassigned queue every 5 minutes via `chrome.alarms`, fires notifications + sounds, updates the badge
- `popup.html` / `popup.js` — toolbar popup: My Tickets / Unassigned tabs, mark-as-read controls
- `options.html` / `options.js` — setup page: pick your name, alert sound settings
- `offscreen.html` / `offscreen.js` — hidden document that actually plays the alert sound (MV3 service workers can't play audio directly)
- `icons/` — generated PNG icons (brand purple for the toolbar icon, red/green dots for notifications)
- `sounds/` — generated WAV alert tones (chime/ping/bell), synthesized locally — no external assets
