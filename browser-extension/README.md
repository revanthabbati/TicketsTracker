# Tickets Assignment Tracker Notifier

A small local browser extension that notifies you when a ticket gets assigned to you in the [Tickets Assignment Tracker](../index.html), since there's no Slack bot for that yet. It shows a desktop notification and a colored badge on the toolbar icon:

- 🔴 **Red** — assigned, initial response (IR) not sent yet
- 🟢 **Green** — IR already sent

It reads the same shared Firestore document the tracker app itself uses. Ticket notifications are read-only; the **Calls** tab (added in 1.4.0) is the only part that writes anything, and it only ever touches your own call-line session and your own availability flag.

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `browser-extension` folder.
5. A setup tab opens automatically — pick your name from the dropdown and click **Save**.

That's it. You'll get a notification whenever a new ticket is assigned to you — with the ticket number, subject, and IR status — and the toolbar icon's badge shows how many of your assignments are still unread (red if any of them are also awaiting an IR, green checkmark once you're caught up). Click the toolbar icon any time to see your recent assignments, each with its subject line.

## My Tickets / Unassigned tabs

The popup has three tabs (the third, **Calls**, is covered below):
- **My Tickets** — your assignments, as above.
- **Unassigned** — a live view of Zendesk's unassigned queue (same query as the app's Zendesk Queue "Unassigned" tab). A ticket only ever appears here until someone actually assigns it in Zendesk, at which point it drops off this list and (if it was assigned to you) shows up under My Tickets instead.

## Calls tab

Check in and out of a call line without opening the tracker. It shows:

- **your status** — which line you're on and how long you've been on it, counting up live
- **Line picker + Check In** — full and closed lines aren't offered. Checking in while already
  on a line *moves* you, closing the previous session so your time is never counted twice.
- **Check Out** — ends the session and records the duration
- **Set Away / I'm Back** — for breaks. Going Away checks you out of your line **and** turns off
  your availability on the floor, so the tracker stops assigning you tickets. Coming back turns
  availability on again and puts you back on the line you left, if a seat is still free.
- **the live board** — who is on each line right now, and who is on a break

Everything syncs with the main app, because both write the same Firestore document. The app
shows the same board under its own **Call Lines** tab.

The tab acts as whoever you picked in setup, so make sure that's you — see *Changing your
identity* below.

### How it writes safely

Everyone on shift writes the same `lineSessions` array at once. Reading it, appending, and
writing the whole thing back would silently erase anyone who wrote in between — that is what
once cost the tracker five user accounts on a different array.

The extension has no Firebase SDK, so it can't use the app's `runTransaction`. It uses the REST
equivalent instead: the document's `updateTime` is captured when reading and sent back as a
precondition on the write. If anyone committed in the meantime, Firestore rejects it and the
extension re-reads and reapplies rather than forcing the write through. After a few failed
attempts it gives up and tells you to try again, which is the correct outcome — it never
overwrites somebody else's session. `updateMask` limits each write to the fields it actually
changes, so nothing else in the document is touched.

`node tools/lines-ext-check.js` from the repo root exercises all of this against a fake that
enforces Firestore's real REST contract, including a simulated concurrent write.

## Marking tickets as read

Every assignment starts out unread. You can clear it three ways:
- Click **Read** next to a ticket in the popup
- Click the ticket link itself (opening it counts as reading it)
- Click **Mark all read** to clear everything, not just what's currently visible

Marking something read removes it from the unread count that drives the toolbar badge, but it stays in the list (dimmed) so you can still find it, or click **Unread** to put it back. This is purely local to your browser — it's never written back to the shared tracker data, so it doesn't affect anyone else or the app itself.

## Unassigned queue alert

Separately from your own assignments, this checks Zendesk every 5 minutes for tickets sitting with no assignee at all. If there are any, you'll get a notification that repeats every 5 minutes until the queue is cleared; clicking it opens the tracker app. This runs regardless of whether you've set up your name yet — it's account-wide, not personal.

## Alert sound

On by default (Chime — Ping and Bell are also available in Options, along with an off switch and a Test button). Plays whenever a new-assignment or unassigned-queue notification fires. Since 1.5.0 you can also set the volume and upload your own sound — see below.

## Volume and your own sounds

Both live on the options page (right-click the toolbar icon → **Options**).

**Volume** is a slider from 0 to 100%. It saves as you move it — there is nothing to click
afterwards — and **Test** plays at whatever the slider currently shows, so you can find a level
that carries without making you jump. Alerts play at full volume until you move it, so updating
the extension never quietly turns your alerts down.

**Your own sounds** lets you upload an audio file to use instead of Chime/Ping/Bell. Uploading
one selects it straight away; click **Save** to start using it for real alerts. Each uploaded
sound gets **Use**, **Play** and **Delete**.

- Up to **1 MB per file**, **4 MB in total**. `chrome.storage.local` gives the whole extension
  10 MB and the ticket caches share it, so uploads get a deliberately modest slice. An alert
  tone that needs more than 1 MB is the wrong file for the job — trim the clip instead.
- Any format your browser can play works (MP3, WAV, OGG, M4A). The file is **actually decoded
  before it is accepted** rather than trusted on its extension, so a file that would fail
  silently at 2am is rejected while you are looking at it.
- Sounds are stored **in this browser only**. Nothing is uploaded anywhere, nothing is written
  to the shared tracker document, and nobody else hears your choice. That also means they do
  not follow you to another machine — upload again there.
- Deleting the sound you are currently using puts you back on Chime rather than leaving you
  with silence.

## Known limitation

The red/green **dot** on each ticket reflects the tracker app's own `irSent` field, which is only set when someone uses the app's **Send IR** button (in the Zendesk Queue tab). If a ticket was assigned through any other flow (Zendesk Queue's plain **Assign** button, or the Dashboard/CSE/CSM/Management manual-link forms) and the agent replies directly in Zendesk instead of using **Send IR**, this extension has no way to know that happened — the dot stays red for that ticket even after you've handled it. Marking it **read** is the way to clear it from your attention regardless. This was a deliberate simplicity tradeoff, not an oversight.

## Changing your identity or sound settings

Open the extension's options page again (right-click the toolbar icon → **Options**, or `chrome://extensions` → this extension → **Details** → **Extension options**) to pick a different name or change the alert sound. Switching identities resets what counts as "already seen" so you won't get a flood of notifications for the new person's entire ticket history.

## Files

- `manifest.json` — extension manifest (Manifest V3)
- `firestore.js` — shared helper for reading the tracker's Firestore doc, fetching ticket subjects and the unassigned queue from Zendesk, computing read/unread + badge state, and (1.4.0) writing call-line check-ins safely via an updateTime precondition
- `background.js` — service worker: polls your assignments every minute and the unassigned queue every 5 minutes via `chrome.alarms`, fires notifications + sounds, updates the badge
- `popup.html` / `popup.js` — toolbar popup: My Tickets / Unassigned / Calls tabs, mark-as-read controls, line check-in/out and Away
- `options.html` / `options.js` — setup page: pick your name, alert sound, volume, and uploading/removing your own sounds
- `offscreen.html` / `offscreen.js` — hidden document that actually plays the alert sound (MV3 service workers can't play audio directly), including resolving and playing uploaded sounds at the chosen volume
- `icons/` — generated PNG icons (brand purple for the toolbar icon, red/green dots for notifications)
- `sounds/` — generated WAV alert tones (chime/ping/bell), synthesized locally — no external assets
