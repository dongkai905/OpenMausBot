# Proactive routines and the brief

What [Proactive routines](../proactive-routines.md) promises, and how to see it
without a real Google account, a model or the Electron app.

## MausBot as the owner

```sh
pnpm exec vitest run server/host/proactive-mausbot.test.ts
```

Each step starts the store, the routines and the proactive side from the files
on disk, as a restart does, with a stand-in for connected apps and no model.
Expected:

- A new install's MausBot is its Chief and gets the one watch. On an install
  where MausBot came after the Chief, the watch is made on MausBot.
- An existing install's watch moves from the Chief to MausBot once: same id,
  paused if it was paused, the edited instructions, the checks' state file
  unchanged, the day's run count kept. The brief's home becomes MausBot's chat,
  its intro shows again, and the Chief keeps its past card. Starting again
  changes nothing, and a routine the person puts back on the Chief stays there.
  A `watch.json` from before the handover still hands over once.
- A restart after the routine moved but before the brief and `watch.json`
  followed finishes the handover with no second watch.
- With a watch already on MausBot, the Chief's is kept and MausBot's own is
  paused; a paused watch stays paused and nothing else is left on. A queued run
  holds the handover until it ends. A frozen computer hands nothing over.
- MausBot hidden from the sidebar gets the brief card, its notification, the
  first-open answer and the add-a-key card; today's earlier card stays in the
  Chief's chat.
- On a Team Cloud there is no watch and nothing is handed over, and a member's
  MausBot is never the proactive bot, so its briefing routine reads nothing.
- A move to My Cloud leaves an untouched MausBot behind while its watch is
  exactly as the server made it, and carries MausBot with the watch once the
  person changed it, even when nobody opened MausBot. A send that carries no
  routines is unchanged. On My Cloud the arrived watch is the only one on, and
  My Cloud's own is paused.

## Unit tests

`server/routine-checks-engine.test.ts` covers the routine engine with checks:
quiet ticks, one batched run, overlap, catch-up, wake times, backoff, the daily
cap, busy bots, and Run now. The others:

- `server/host/routine-checks.test.ts`, `server/host/check-plan.test.ts` and
  `server/host/check-prompts.test.ts`: the checks, planner and prompts;
- `server/host/brief.test.ts`, `server/host/proactive.test.ts` and
  `server/host/proactive-mausbot.test.ts`: the brief, the default routine and
  its owner;
- `server/connected-reads.test.ts` and `server/records-block.test.ts`: the
  readers and the sanitiser;
- `server/read-and-draft.test.ts`: the fence;
- `server/routes/bot-messages.test.ts` and `server/routes/presence.test.ts`: the
  press fences and presence;
- `src/lib/automations.test.ts`: the Automations row.

## Looking at it in the real renderer

1. Start the fixture from a script that calls `launchVerificationServer`, and
   drive it as the end-to-end test does: `POST /api/presence/active`, then
   `POST /api/routines/<watch>/run`.
2. Serve the renderer against it:
   `OMB_PORT=<fixture port> pnpm exec vite --port 19872 --strictPort`.
3. Open `http://127.0.0.1:19872/` in a headless Chromium. Dismiss the welcome
   tour, then open MausBot's chat and Automations. In the chat, the cards are
   `[data-widget]` elements.

Not verified this way: a real Google account.
