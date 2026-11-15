# A new Cloud's first hour

What a new personal Cloud's Chief does in its first hour and day
(`server/host/first-hour.ts`), and how to see it without a real Google account,
a model or the Electron app.

## The end-to-end scenario

```sh
pnpm exec vitest run server/first-hour.e2e.test.ts
```

It starts a real Cloud home (`OMB_CLOUD_ROLE=home`) in a temporary home with
the fake Claude CLI. Nothing reaches a real account or a model.

Expected:

- The Chief's chat is the first thing: one message, "Hi Sam! I'm MausBot, your
  Chief of Staff. … What do you want off your plate?", the Cloud's welcome steps
  recorded as done (`cloud-welcome-done`) and MausBot's own welcome card off.

## The pieces

```sh
pnpm exec vitest run server/host/first-hour.test.ts server/host/brief-morning.test.ts server/host/first-hour-words.test.ts server/host/value-ledger.test.ts
```

- `server/host/first-hour.test.ts`: the greeting in the person's language and by name only
  while unanswered; the brief line and the phone, each once; the day-two recap
  ("So far I've sorted 40 emails, drafted 6 replies and prepped 4 meetings:
  about 2 hours back.") only after 8:00 on day two, once, and never when
  nothing was done.
- `server/host/brief-morning.test.ts`: the brief posted and pushed at 8:00 in the person's
  zone and not a minute before, once a day; its first line from the counts since
  the person was last here, left out when they just were; a running watch run
  waited for up to 20 minutes; the wake ten minutes early, through a clock
  change; nothing where no morning time is set.
