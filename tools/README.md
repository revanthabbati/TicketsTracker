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

## Diagnosing a bad answer in the app

The app logs each planner decision to the browser console as `AI Search plan: {...}`. Nearly
every AI Search bug so far has been the planner misreading the question, which the answer
alone doesn't reveal. If an answer looks wrong, open devtools, copy that line, and pair it
with the "Interpreted as:" queries shown under the composer.
