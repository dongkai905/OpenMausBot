import assert from "node:assert/strict";
import test from "node:test";

import { createOneHome, QUIET_MS } from "./one-home.mjs";

const CLOUD = "https://omb-t-1.fly.dev";
const reply = (status, body = {}) => ({ ok: status < 400, status, body });
/**
 * My Cloud and two computers that move to it, each with its own app, journal, choice ("Keep this computer's bots on this
 * computer") and server. Each computer's waits are on or off, and run while it is not frozen; My Cloud has its own. A
 * come-home stages My Cloud's backup, and its restore replaces what the computer has with My Cloud's things, every wait
 * off. `events` is the order things happened in.
 */
function world() {
  let clock = 1_000_000;
  const timers = [];
  const cloud = { on: { "wait:c1": true }, ready: true, moves: true, exports: 0, kept: [], moved: [] };
  const events = [];
  const make = (id, name, own) => {
    const desk = {
      id, name, journal: null, keep: null, server: { frozen: false, freezes: 0, on: { ...own }, thaws: [] }, carried: {}, passes: 0, restored: 0, restarted: 0,
      opened: [], localCalls: [], crashOn: null,
      live: () => (desk.server.frozen ? [] : Object.keys(desk.server.on).filter((key) => desk.server.on[key]).sort()),
    };
    desk.make = () => {
      // What one run of the app staged, as main keeps it.
      let staged = null;
      const stage = async () => {
        if (w.stageFails) throw new Error("My Cloud's backup could not be taken yet.");
        if (!staged) { cloud.exports++; staged = { ...cloud.on }; events.push(`${id}: My Cloud's backup staged`); }
        return { staged: true };
      };
      return createOneHome({
      journal: {
        read: () => structuredClone(desk.journal),
        write: (value) => {
          if (desk.crashOn?.(value)) { desk.crashOn = null; throw new Error("the app was killed"); }
          desk.journal = structuredClone(value);
        },
      },
      keep: { read: () => structuredClone(desk.keep), write: (value) => { desk.keep = structuredClone(value); } },
      cloud: () => ({ origin: CLOUD, account: "acct-1", machine: CLOUD, ready: cloud.ready, moves: cloud.moves, ended: false, paid: true, signIn: `${id}-sign-in` }),
      send: {
        async move(options) {
          desk.passes++;
          w.onPass?.(desk, options);
        },
        check: async () => ({ ok: true }),
        snapshot: () => ({ running: null }),
      },
      local: {
        async freeze() { if (!desk.server.frozen) desk.server.freezes++; desk.server.frozen = true; return { frozen: true }; },
        async unfreeze(options) {
          desk.server.thaws.push(options ?? null);
          if (options?.automations === "off") for (const key of Object.keys(desk.server.on)) desk.server.on[key] = false;
          desk.server.frozen = false;
          events.push(`${id}: open here, ${options?.automations === "off" ? "nothing running" : "as it was"}`);
        },
        frozen: async () => desk.server.frozen,
        async json(route) {
          if (route === "/api/cloud-connections") return { computer: { label: name } };
          if (route === "/api/cloud-send/manifest") return { items: [], conversations: [] };
          return { bots: [] };
        },
        async call(method, route, body) {
          desk.localCalls.push([method, route, body]);
          return reply(200, { v: 1 });
        },
      },
      session: async () => ({
        async call() { return reply(200, { v: 1 }); },
        close: async () => {},
      }),
      keepHome: {
        stage,
        async bring() {
          await stage();
          desk.server.on = Object.fromEntries(Object.keys(staged).map((key) => [key, false]));
          staged = null;
          desk.restored++;
          events.push(`${id}: restored`);
          return { restored: `restore-${id}-${desk.restored}` };
        },
      },
      installation: async () => `installation-${id}`,
      reportMove: async () => { cloud.moved.push(id); return true; },
      reportKept: async () => { cloud.kept.push(id); return true; },
      phone: { paired: () => false, stop: async () => {}, start: async () => {} },
      openHome: () => desk.opened.push("cloud"),
      openLocal: () => desk.opened.push("local"),
      lastInput: () => w.typedAt,
      restart: () => { desk.restarted++; },
      version: "0.1.125",
      now: () => clock,
      timers: { set: (work, ms) => { const timer = { work, ms }; timers.push(timer); return timer; }, clear: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); } },
      });
    };
    desk.relaunch = () => { desk.home?.close(); desk.home = desk.make(); return desk.home; };
    desk.home = desk.make();
    return desk;
  };
  const w = {
    cloud, events, typedAt: 0, onPass: null, stageFails: false,
    now: () => clock,
    a: make("a", "MacBook Air", { "wait:a1": true, "wait:aw": true, "wait:a2": false }),
    b: make("b", "Studio iMac", { "wait:b1": true }),
    advance(ms) { clock += ms; },
    async tick(desk) { const due = timers.splice(0); for (const timer of due) timer.work(); await desk.home.kick(); },
    /** Both computers moved: each is frozen, and My Cloud runs what was on at each. */
    async moved() {
      w.advance(QUIET_MS + 1);
      for (const desk of [w.a, w.b]) { await desk.home.kick(); assert.equal(desk.journal.phase, "done", desk.name); assert.equal(desk.server.frozen, true); }
      assert.deepEqual(w.runningOnCloud(), ["wait:c1"], "nothing of the computers' goes to My Cloud any more");
    },
    runningOnCloud: () => Object.keys(cloud.on).filter((key) => cloud.on[key]).sort(),
    /** Each wait that runs in more than one place. */
    twice: () => {
      const places = [w.runningOnCloud(), w.a.live(), w.b.live()].flat();
      return places.filter((key, at) => places.indexOf(key) !== at);
    },
  };
  return w;
}

test("switched on before the move, this computer never moves: no copy, no freeze, nothing on My Cloud, at every launch", async () => {
  const w = world();
  w.cloud.ready = false;
  await w.a.home.keep(true);
  assert.deepEqual(w.a.keep, { v: 1, on: true, at: 1_000_000 }, "kept on this computer");
  w.cloud.ready = true;
  w.advance(QUIET_MS + 1);
  for (let launch = 0; launch < 3; launch++) { await w.a.relaunch().kick(); w.advance(60 * 60_000); await w.tick(w.a); }
  assert.equal(w.a.journal, null);
  assert.deepEqual([w.a.passes, w.a.server.freezes, w.a.server.frozen], [0, 0, false]);
  assert.deepEqual(w.a.live(), ["wait:a1", "wait:aw"], "its waits go on running here");
  assert.deepEqual(w.runningOnCloud(), ["wait:c1"]);
  assert.equal(w.a.home.away(), false, "the window keeps this computer, with the switcher");
  assert.equal(w.a.home.view(), null, "and no line about a move");
  assert.equal(w.a.home.keeps(), true);
  assert.deepEqual([w.cloud.moved, w.cloud.kept], [[], []], "the Admin has nothing to be told");

  // The other computer moves as anyone does.
  await w.b.home.kick();
  assert.equal(w.b.journal.phase, "done");
});

test("switched on while the move goes, the move stops before its switch: a frozen copy opens as it was, and nothing runs on My Cloud", async () => {
  const w = world();
  w.advance(QUIET_MS + 1);
  w.typedAt = w.now();
  await w.a.home.kick();
  assert.equal(w.a.journal.phase, "wait", "copied, and waiting for a quiet moment");
  await w.a.home.keep(true);
  assert.equal(w.a.journal, null);
  assert.deepEqual([w.a.server.freezes, w.a.server.frozen], [0, false]);
  w.advance(QUIET_MS + 1);
  await w.tick(w.a);
  assert.deepEqual([w.a.journal, w.a.passes, w.a.server.freezes], [null, 1, 0], "and it never goes on");

  // Switched on while this computer is frozen for the final pass: the freeze lifts once the pass is over, as the
  // Admin's kill switch lifts it.
  const v = world();
  v.advance(QUIET_MS + 1);
  v.onPass = (desk, options) => { if (options?.final) void desk.home.keep(true); };
  await v.a.home.kick();
  assert.equal(v.a.journal, null);
  assert.deepEqual([v.a.server.freezes, v.a.server.thaws], [1, [null]], "lifted as it was, its waits as they were");
  assert.deepEqual(v.a.live(), ["wait:a1", "wait:aw"]);
  assert.deepEqual(v.runningOnCloud(), ["wait:c1"], "nothing of its own went to My Cloud");
});

test("switched on after this computer moved: its bots come home with My Cloud's backup, everything it runs stops here, and the other computer is untouched", async () => {
  const w = world();
  await w.moved();
  const before = structuredClone({ journal: w.b.journal, server: w.b.server, carried: w.b.carried });
  await w.a.home.keep(true);

  assert.deepEqual(w.events, [
    "a: My Cloud's backup staged",
    "a: open here, nothing running",
    "a: restored",
  ], "the backup is taken before anything changes; this computer opens with nothing running");
  assert.equal(w.a.journal.phase, "back");
  assert.equal(w.a.journal.kept, true);
  assert.equal(w.a.restarted, 1, "the app opens again to finish the restore");
  assert.deepEqual(w.runningOnCloud(), ["wait:c1"], "My Cloud's own goes on");
  assert.deepEqual(w.a.live(), [], "and nothing runs here before the app opens again");

  await w.a.relaunch().kick();
  assert.deepEqual(w.a.live(), [], "nothing runs here: the restore leaves every wait off");
  assert.deepEqual(w.a.server.on, { "wait:c1": false }, "what My Cloud held came too, with every wait off");
  assert.deepEqual(w.a.localCalls.find(([, route]) => route === "/api/cloud-send/home"), ["POST", "/api/cloud-send/home", { v: 1 }],
    "the record of where the bots came from goes");
  assert.deepEqual(w.twice(), [], "nothing runs twice");
  assert.equal(w.a.home.away(), false, "the window goes back to this computer, with the switcher");
  assert.deepEqual(w.a.home.view(), { phase: "back", kept: true });
  assert.deepEqual(w.cloud.kept, ["a"], "the Admin is told this computer no longer counts as moved");

  for (let launch = 0; launch < 2; launch++) await w.a.relaunch().kick();
  assert.deepEqual([w.cloud.exports, w.a.restored, w.a.restarted, w.cloud.kept.length], [1, 1, 1, 1], "once");
  w.a.home.seen();
  assert.equal(w.a.home.view(), null);

  assert.deepEqual({ journal: w.b.journal, server: w.b.server, carried: w.b.carried }, before, "the other computer: nothing changed");
  await w.b.relaunch().kick();
  assert.deepEqual([w.b.journal.phase, w.b.server.frozen, w.b.live()], ["done", true, []]);
  assert.deepEqual(w.runningOnCloud(), ["wait:c1"]);
});

test("switched off again, this computer moves again at the next quiet moment", async () => {
  const w = world();
  await w.moved();
  await w.a.home.keep(true);
  await w.a.relaunch().kick();
  // Changed here since coming home: one switched off, one switched on.
  w.a.server.on["wait:aw"] = false;
  w.a.server.on["wait:a2"] = true;

  w.typedAt = w.now();
  await w.a.home.keep(false);
  assert.equal(w.a.journal.phase, "wait", "it copies at once and waits for a quiet moment");
  assert.equal(w.a.server.frozen, false);
  w.advance(QUIET_MS + 1);
  await w.tick(w.a);
  assert.equal(w.a.journal.phase, "done");
  assert.equal(w.a.journal.kept, undefined);
  assert.deepEqual([w.a.server.frozen, w.a.live()], [true, []]);
  assert.deepEqual(w.runningOnCloud(), ["wait:c1"], "nothing of its own goes to My Cloud now either");
  assert.deepEqual(w.twice(), []);
  assert.equal(w.a.home.away(), true);
  assert.deepEqual(w.cloud.moved, ["a", "b", "a"], "the Admin is told it moved again");
});

test("while this computer's bots are on their way home the switch can't be turned back; killed half-way, it goes on with what was on at My Cloud before", async () => {
  const w = world();
  await w.moved();
  w.a.crashOn = (value) => value?.phase === "back";
  await w.a.home.keep(true).catch(() => {});
  assert.equal(w.a.journal.phase, "keeping");
  assert.equal(w.a.journal.thawed, true, "this computer opened again, so it goes on");
  assert.equal(w.a.home.away(), true, "the window stays on My Cloud meanwhile");
  assert.deepEqual(w.a.home.view(), { phase: "keeping" });
  assert.throws(() => w.a.home.keep(false), /on their way back/u);
  assert.deepEqual(w.runningOnCloud(), ["wait:c1"]);

  await w.a.relaunch().kick();
  assert.equal(w.a.journal.phase, "back");
  assert.equal(w.cloud.exports, 2, "the backup is taken again after the app was killed");
  await w.a.relaunch().kick();
  assert.deepEqual(w.a.live(), [], "nothing runs here: the restore leaves every wait off");
  assert.deepEqual(w.twice(), []);
});

test("turned back off before anything changed on either side, home is My Cloud as it was", async () => {
  const w = world();
  await w.moved();
  const done = structuredClone(w.a.journal);
  w.stageFails = true;
  await w.a.home.keep(true);
  assert.deepEqual([w.a.journal.phase, w.cloud.exports], ["keeping", 0], "My Cloud's backup could not be taken, and nothing else");
  await w.a.home.keep(false);
  const onDisk = (journal) => JSON.parse(JSON.stringify(journal));
  assert.deepEqual(onDisk(w.a.journal), onDisk(done), "the journal is as it was at the move");
  assert.equal(w.a.home.away(), true);
  assert.deepEqual([w.a.server.frozen, w.a.server.thaws, w.a.restored], [true, [], 0]);
  assert.deepEqual(w.runningOnCloud(), ["wait:c1"]);
  w.stageFails = false;
  w.advance(60 * 60_000);
  await w.tick(w.a);
  assert.equal(w.a.journal.phase, "done", "and it stays home on My Cloud");
  assert.equal(w.a.restored, 0);
});
