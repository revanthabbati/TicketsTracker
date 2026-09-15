# tools/

Developer utilities. Not part of the deployed site — nothing here is loaded by `index.html`.

## `ai-search-check.js`

Shows how the AI Search planner interprets questions, so prompt changes can be checked
without clicking through the app.

```bash
node tools/ai-search-check.js
```

```bash
node tools/ai-search-check.js "how many onhold tickets are there with harsha"
```

```bash
node tools/ai-search-check.js --run
```

- No arguments runs a built-in set of questions covering the cases that have broken before
  (agent-name lookup, CSAT counts, customer/account names, follow-ups).
- Any non-flag arguments are treated as questions to run instead.
- `--run` additionally asks Zendesk how many tickets each generated query actually matches,
  which is how you catch a query that is valid but matches nothing.

Requires Node 18 or newer. No `npm install`, no configuration — it reads the same public
Firestore settings document the app does.

### What it checks automatically

For every question it prints the planner's decision (`action`, `countOnly`, `listOnly`,
`needsComments`) and the Zendesk queries it produced, then flags:

- **an email that isn't in the agent roster** — the regression that made "how many on-hold
  tickets with harsha" return 0, because the planner invented `harsha@dispatchtrack.com`
  instead of using `harsha.uppala@dispatchtrack.com`
- a query missing `type:ticket`
- `action: "search"` with no queries
- `countOnly` and `listOnly` both set

Exit code is non-zero if anything was flagged, so it can gate a commit if you ever want that.

### It reads the prompt out of `index.html`

The harness does not keep its own copy of the planner prompt — it extracts
`planAiChatTurn()` and its helpers from `index.html` at runtime and runs the real thing.
A second copy would quietly rot and end up testing a prompt that no longer ships.

The tradeoff is that renaming those functions breaks the harness. That is deliberate: it
fails with `Could not find function planAiChatTurn() in index.html — this harness needs
updating` rather than testing something stale. If you see that, update the function names in
`loadAppCode()`.

### What it sends where

Running it sends your question, the ticket IDs in the simulated context, and the agent roster
(names and Zendesk emails) to Google's Gemini API — the same call the app makes when you use
the tab. With `--run` it also queries Zendesk through the usual Cloudflare proxy.

It does **not** send ticket subjects, descriptions or comment threads anywhere. It only
exercises the planner, which never sees ticket contents.

## `lines-check.js`

Checks the Call Lines check-in/check-out logic, including the cases you cannot reproduce by
clicking through the app because they need two people acting at once.

```bash
node tools/lines-check.js
```

Runs 65 assertions covering:

- **seat capacity under a race** — two agents taking the last seat at the same instant, with a
  second client deliberately committing mid-transaction. A line must never exceed its capacity.
- **line switching** — moving to another line closes the previous session, so time is never
  double-counted across two open sessions.
- **check-out is idempotent** — a second check-out (another tab, or a supervisor at the same
  moment) must not overwrite the recorded time or the name of whoever closed it.
- **session pruning** — the 4000-session cap drops only the oldest *closed* sessions; an open
  one is never pruned, however old, or an agent would silently lose a running session.
- duration maths, including malformed and reversed timestamps.
- identity resolution (user → agent record via `zendeskAgentEmail`) and the permission helper.
- **Away / breaks** — that going Away closes the line session *and* clears floor availability,
  remembers the line, restores both on return, and leaves every other agent's record untouched.
  This one matters because it writes the `agents` array, which the round-robin and the shift
  evaluator both depend on.
- that writes touch **only** the fields they should and leave `users` and `tickets`
  byte-identical.

It reads the functions out of `index.html` at runtime, so it tests what actually ships. It
talks to nothing — no Firestore, no Zendesk, no credentials, no production data.

## `lines-ext-check.js`

Checks that the **browser extension** can write call-line check-ins to the shared Firestore
document without destroying anyone else's data.

```bash
node tools/lines-ext-check.js
```

The extension has no Firebase SDK and so no `runTransaction`; it uses an `updateTime`
precondition on the REST commit instead. `fetch` is faked here with a server that enforces
Firestore's actual REST contract, so the two mistakes that would only surface in production
fail here instead:

- **integers must be sent as strings** (`{integerValue: "42"}`) — Firestore rejects a JSON
  number there, and nothing in the browser would tell you until a real write 400s.
- **a stale `updateTime` must be rejected**, and the extension must then re-read and reapply.
  One test commits a competing session mid-flight and asserts that it **survives** our write.

It also covers capacity, closed lines, line switching, check-out, and that Away clears floor
availability and closes the line session in a *single* commit, so it can never half-apply.

Like the other harnesses it reads the real functions out of `browser-extension/firestore.js`
at runtime. No network, no credentials, no production data.

**What it cannot tell you:** whether the project's Firestore security rules permit an
unauthenticated REST write at all. Only a real request answers that, so the first time anyone
loads v1.4.0, check that a check-in actually sticks. If rules reject it the popup says
"permission denied" rather than failing silently.

## Diagnosing a bad answer in the app

The app logs each planner decision to the browser console as `AI Search plan: {...}`. Nearly
every AI Search bug so far has been the planner misreading the question, which the answer
alone doesn't reveal. If an answer looks wrong, open devtools, copy that line, and pair it
with the "Interpreted as:" queries shown under the composer.
