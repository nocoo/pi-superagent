/** Persistence: aggregates round-trip, settings are versioned, and an outbox receipt is idempotent by message id. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import type { Ticket, Trigger } from "../src/core/index.ts";

const dirs: string[] = [];
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), "pi-superagent-"));
  dirs.push(dir);
  return new Store(join(dir, "state.sqlite"));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const trigger = (id: string): Trigger => ({
  id,
  source: "github",
  threads: [{ source: "github", id: "1" }],
  actor: { source: "github", id: "alice" },
  human: true,
  at: "2026-01-01T00:00:00.000Z",
  text: `message ${id}`,
  meta: { kind: "issue" },
});

describe("the store", () => {
  it("stamps the schema version on a new database and reopens it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-superagent-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    new Store(path).close();
    const reopened = new Store(path);
    expect(reopened.get("schema" as never)).toBe(1);
    reopened.close();
  });

  it("opens a real read-only connection while the owner holds a write transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "store-reader-"));
    dirs.push(directory);
    const path = join(directory, "state.sqlite");
    const writer = new Store(path);
    let reader: Store | undefined;
    try {
      writer.db.exec("BEGIN IMMEDIATE");
      reader = new Store(path, undefined, { readOnly: true });
      expect(reader.settings().eval.mode).toBe("observe");
      expect(() => reader!.set("should-not-write", true)).toThrow(/readonly/i);
    } finally {
      reader?.close();
      writer.db.exec("ROLLBACK");
      writer.close();
    }
  });

  it("returns default settings before anything is saved", () => {
    const open = store();
    const settings = open.settings();
    expect(settings.eval.mode).toBe("observe");
    expect(settings.executor.maxWorkers).toBe(3);
    expect(settings.policy.rules.map((rule) => rule.id)).toEqual(["copy", "visual"]);
    open.close();
  });

  it("keeps saved settings as the current revision and preserves the earlier one", () => {
    const open = store();
    open.saveSettings(
      { eval: { mode: "auto" } },
      {
        source: "internal",
        block: "policy",
        policyVersion: "v1",
        policyChanged: false,
        notified: [],
      },
    );
    expect(open.settings().eval.mode).toBe("auto");
    expect(open.settingsHistory().map((version) => version.revision)).toEqual([1]);
    expect(open.blockRevision("policy")).toBe(1);
    open.close();
  });

  it("stores triggers, dispositions, and the thread index used by polling", () => {
    const open = store();
    open.triggers.save(trigger("a"));
    open.triggers.saveDisposition("a", { fanout: [], at: "2026-01-01T00:00:01.000Z" });
    expect(open.triggers.get("a")?.text).toBe("message a");
    expect(open.triggers.disposition("a")?.fanout).toEqual([]);
    expect(open.read.threadTriggers("github:1").map((item) => item.id)).toEqual(["a"]);
    open.close();
  });

  it("lists only open tickets, newest first, so the coordination loop scans a small working set", () => {
    const open = store();
    const ticket = (id: string, ended = false): Ticket =>
      ({
        id,
        title: id,
        decisionId: "d",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        channels: [],
        assignments: [],
        inputs: [],
        undelivered: [],
        origin: { triggerId: "a", triggerIds: ["a"] },
        mandate: {
          strength: "explicit",
          policyVersion: "v",
          scope: "s",
          actor: { source: "github", id: "alice" },
          basis: { via: "addressed", addressed: "mention" },
        },
        ...(ended
          ? { ended: { at: "2026-01-01T00:00:02.000Z", by: "executor", outcome: "completed" } }
          : {}),
      }) as Ticket;
    open.atomic(() => {
      open.tickets.save(ticket("first"));
      open.tickets.save(ticket("second"));
      open.tickets.save(ticket("done", true));
    });
    expect(open.tickets.list().map((item) => item.id)).toEqual(["done", "second", "first"]);
    expect(open.tickets.open().map((item) => item.id)).toEqual(["second", "first"]);
    open.close();
  });

  it("records a message receipt once, so a retried send cannot post twice", () => {
    const open = store();
    const message = {
      id: "m1",
      channel: { source: "github", thread: "1", address: { number: "1" } },
      text: "hello",
      kind: "acknowledgement" as const,
    };
    expect(open.receipts.add(message)).toBe(true);
    expect(open.receipts.add(message)).toBe(false);
    expect(open.replyStatus("m1")).toBe("pending");
    open.receipts.settle(message, "sent");
    expect(open.replyStatus("m1")).toBe("sent");
    expect(open.receipts.add(message)).toBe(false);
    open.close();
  });

  it("runs afterCommit callbacks only once the outermost transaction commits", () => {
    const open = store();
    const seen: string[] = [];
    open.atomic(() => {
      open.afterCommit(() => seen.push("outer"));
    });
    expect(seen).toEqual(["outer"]);
    expect(() =>
      open.atomic(() => {
        open.afterCommit(() => seen.push("rolled back"));
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(seen).toEqual(["outer"]);
    open.close();
  });

  it("serves read-only queries for triggers, decisions, threads, outbox, and effect queues", () => {
    const open = store();
    const t1: Trigger = {
      ...trigger("t-one_100%"),
      url: "https://github.com/o/r/issues/1",
      at: "2026-01-01T00:00:01.000Z",
      meta: { kind: "issue", messageId: "m-1" },
    };
    const t2: Trigger = {
      ...trigger("t-ci"),
      human: false,
      at: "2026-01-01T00:00:02.000Z",
      meta: { ci: true },
    };
    const t3: Trigger = {
      ...trigger("t-two"),
      at: "2026-01-01T00:00:03.000Z",
      text: "follow up 100% needed",
    };
    open.triggers.save(t1);
    open.triggers.saveDisposition(t1.id, { fanout: [], at: t1.at });
    open.triggers.save(t2);
    open.triggers.saveDisposition(t2.id, {
      filtered: { code: "senderNotMember" },
      fanout: [],
      at: t2.at,
    });
    open.triggers.save(t3);
    open.triggers.saveDisposition(t3.id, { fanout: [], at: t3.at });

    open.threads.save({
      key: "github:1",
      ref: { source: "github", id: "1" },
      createdAt: t1.at,
      lastAt: t3.at,
      subscriptions: ["tk1"],
      correlated: [],
      pending: [],
      meta: {},
    });
    open.decisions.save({
      id: "d-acc",
      evalId: "e1",
      threadKey: "github:1",
      triggerIds: [t1.id],
      policyVersion: "v1",
      at: "2026-01-01T00:00:01.500Z",
      kind: "accept",
      reason: [],
      strength: "explicit",
      ticketId: "tk1",
    });
    open.decisions.save({
      id: "d-unavail",
      evalId: "e2",
      threadKey: "github:1",
      triggerIds: [t3.id],
      policyVersion: "v1",
      at: "2026-01-01T00:00:03.500Z",
      kind: "unavailable",
      reason: [{ code: "timeout" }],
      strength: "explicit",
    });

    const msgPending = {
      id: "out-pending",
      channel: { source: "github", thread: "github:1", address: { number: "1" } },
      text: "wait",
      kind: "reply" as const,
    };
    const msgDropped = {
      id: "out-dropped",
      channel: { source: "github", thread: "github:1", address: { number: "1" } },
      text: "gone",
      kind: "reply" as const,
    };
    open.receipts.add(msgPending);
    open.receipts.add(msgDropped);
    open.receipts.settle(msgDropped, "channelGone");
    open.db
      .prepare(
        "INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("reply", "out-pending", "{}", 1, 2, "HTTP 502", 0, "2026-01-01T00:00:04.000Z");

    expect(open.read.recentTriggers(0, 2).map((t) => t.id)).toEqual(["t-two", "t-ci"]);
    expect(open.read.triggerStats("2026-01-01T00:00:00.000Z").github).toEqual({
      received: 3,
      filtered: 1,
      lastAt: "2026-01-01T00:00:03.000Z",
    });
    expect(open.read.flow("2026-01-01T00:00:00.000Z")).toEqual({ judged: 2, accepted: 1 });
    expect(open.read.triggers({ source: "github", filtered: true }).items.map((t) => t.id)).toEqual(
      ["t-ci"],
    );
    expect(open.read.threadPage("github:1", 0, 2).map((t) => t.id)).toEqual(["t-two", "t-ci"]);
    // Neighbours skip CI triggers
    expect(open.read.neighbours("github:1", t3.at, t3.id).before?.id).toBe(t1.id);
    expect(open.read.firstTrigger("github:1", true)?.id).toBe(t1.id);
    expect(open.read.search("100%").map((t) => t.id)).toEqual(["t-two", "t-one_100%"]);
    expect(open.read.triggersByPrefix("t-one_").map((t) => t.id)).toEqual(["t-one_100%"]);
    expect(open.read.triggerCounts()["github:1"]).toBe(3);

    expect(open.read.recentDecisions().map((d) => d.id)).toEqual(["d-unavail", "d-acc"]);
    expect(
      open.read
        .decisions({ kinds: ["accept"], since: "2026-01-01T00:00:00.000Z" }, 0, 10)
        .items.map((d) => d.id),
    ).toEqual(["d-acc"]);
    expect(open.read.decisionsOfKinds(["unavailable"]).map((d) => d.id)).toEqual(["d-unavail"]);
    expect(open.read.unavailable("2026-01-01T00:00:00.000Z").map((d) => d.id)).toEqual([
      "d-unavail",
    ]);

    expect(open.read.failingReplies()).toMatchObject([
      { id: "out-pending", attempts: 2, error: "HTTP 502" },
    ]);
    expect(open.read.droppedReplies().map((d) => d.id)).toEqual(["out-dropped"]);
    expect(open.read.droppedSince("2026-01-01T00:00:00.000Z")).toBe(1);
    expect(open.read.queue()).toEqual([
      { kind: "reply", waiting: 1, failing: 1, oldest: "2026-01-01T00:00:04.000Z" },
    ]);
    expect(open.read.receipts()).toEqual({ pending: 1, sent: 0, dropped: 1 });
    expect(open.read.subscribedThreads().map((t) => t.key)).toEqual(["github:1"]);
    expect(open.read.subscribedThreads("github").map((t) => t.key)).toEqual(["github:1"]);
    open.close();
  });
});
