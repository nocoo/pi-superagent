import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchCiTrigger,
  ciTrigger,
  commentTrigger,
  githubAddress,
  isHumanLogin,
  issueTrigger,
  mentions,
  pullTrigger,
  reviewPlace,
} from "../src/sources/github-trigger.ts";
import {
  agentPull,
  claimPull,
  observePull,
  pullEndNotices,
  pullOf,
  pullsOf,
  ticketBranch,
  type Pull,
} from "../src/sources/github-pull.ts";
import { cursorAt, pause, polled, POLL_HORIZON_MS, pollThreads } from "../src/sources/poll.ts";
import type { SourceContext } from "../src/sources/host.ts";
import type { Thread, Ticket, Trigger } from "../src/core/index.ts";

afterEach(() => {
  vi.useRealTimers();
});

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "tk-1",
  title: "Fix bug",
  decisionId: "dec-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  mandate: {
    strength: "explicit",
    policyVersion: "v1",
    actor: { source: "github", id: "alice" },
    scope: "Fix bug",
    basis: { via: "addressed", addressed: "mention" },
  },
  channels: [],
  origin: { triggerId: "tr-origin", triggerIds: ["tr-origin"] },
  inputs: [],
  undelivered: [],
  assignments: [],
  execution: { name: "fix-bug", directory: "/tmp/w", assignment: "Fix bug" },
  ...overrides,
});

const makePull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 42,
  state: "open",
  html_url: "https://github.com/owner/repo/pull/42",
  user: { login: "super-bot", type: "User" },
  head: { sha: "abc", ref: "agent/fix-bug", repo: { full_name: "Owner/Repo" } },
  ...overrides,
});

describe("github-trigger", () => {
  it("parses GitHub issue, PR, API, and discussion URLs only for the configured repo", () => {
    expect(githubAddress("https://github.com/Owner/Repo/issues/12", "owner/repo")).toEqual({
      number: 12,
      pr: false,
    });
    expect(
      githubAddress("https://github.com/owner/repo/pull/99#discussion_r555", "owner/repo"),
    ).toEqual({ number: 99, pr: true, discussion: 555 });
    expect(githubAddress("https://api.github.com/repos/owner/repo/pulls/7", "owner/repo")).toEqual({
      number: 7,
      pr: true,
    });
    expect(githubAddress("https://github.com/other/repo/issues/1", "owner/repo")).toBeUndefined();
  });

  it("classifies human vs bot logins and detects exact @mentions", () => {
    expect(isHumanLogin({ login: "alice", type: "User" })).toBe(true);
    expect(isHumanLogin({ login: "dependabot[bot]", type: "Bot" })).toBe(false);
    expect(isHumanLogin({ login: "ci-app", type: "Bot" })).toBe(false);

    expect(mentions("Please check @SuperBot!", "superbot")).toBe(true);
    expect(mentions("@superbot-dev no", "superbot")).toBe(false);
    expect(mentions("mail@superbot", "superbot")).toBe(false);
  });

  it("normalizes comment, review, inline diff, issue, pull, and CI triggers", () => {
    const inline = commentTrigger(
      {
        id: 10,
        body: "@bot please fix",
        user: { login: "alice", type: "User" },
        html_url: "https://github.com/owner/repo/pull/5#discussion_r10",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:01:00.000Z",
        path: "src/app.ts",
        original_line: 18,
        diff_hunk: "l1\nl2\nl3\nl4",
        in_reply_to_id: 9,
      },
      { number: 5, isPr: true, prAuthor: "alice" },
      "inline",
      "bot",
    );
    expect(inline.human).toBe(true);
    expect(inline.addressed).toBe("mention");
    expect(inline.text).toContain("src/app.ts:18\nl2\nl3\nl4");
    expect(inline.meta).toMatchObject({ path: "src/app.ts", line: 18, inReplyTo: 9 });

    const review = commentTrigger(
      {
        id: 11,
        body: "Looks good",
        user: { login: "bob", type: "User" },
        submitted_at: "2026-01-01T00:02:00.000Z",
        state: "CHANGES_REQUESTED",
        commit_id: "deadbeef",
      },
      { number: 5, isPr: true },
      "review",
      "bob",
    );
    expect(review.human).toBe(false); // agent's own comment
    expect(review.text).toContain("CHANGES_REQUESTED review of commit deadbeef");
    expect(reviewPlace({ id: 1, user: { login: "a" }, path: "x.ts" })).toBe("x.ts");

    const issue = issueTrigger(
      {
        number: 3,
        title: "Bug",
        body: "Hey @bot",
        user: { login: "ghost", type: "User" },
        created_at: "2026-01-01T00:00:00.000Z",
        html_url: "https://github.com/owner/repo/issues/3",
      },
      "bot",
    );
    expect(issue.addressed).toBe("mention");
    expect(issue.meta).toMatchObject({ number: 3, isPr: false, kind: "issue" });

    const pull = pullTrigger(
      {
        number: 4,
        title: "PR",
        body: null,
        user: { login: "alice", type: "User" },
        created_at: "2026-01-01T00:00:00.000Z",
        html_url: "https://github.com/owner/repo/pull/4",
      },
      "bot",
    );
    expect(pull.meta).toMatchObject({ number: 4, isPr: true, prAuthor: "alice", kind: "pull" });

    const bci = branchCiTrigger("main", "sha1", 2, "failed", "https://ci");
    expect(bci.channel).toBeUndefined();
    expect(bci.threads).toEqual([{ source: "github", id: "ci:main" }]);

    const pci = ciTrigger(
      { number: 4, html_url: "https://github.com/owner/repo/pull/4", user: { login: "alice" } },
      1,
      "ci passed",
    );
    expect(pci.channel?.thread).toBe("github:4");
  });
});

describe("github-pull", () => {
  function mockContext(tickets: Ticket[], triggers: Record<string, Trigger> = {}) {
    const bound: { id: string; thread: string; own: boolean }[] = [];
    const closed: { thread: string; outcome: string; at: string }[] = [];
    const described: { key: string; facts: unknown }[] = [];
    const patched: { key: string; meta: Record<string, unknown> }[] = [];
    const ctx = {
      deployment: {
        repository: "owner/repo",
        github: { cli: "gh", login: "super-bot", noreply: "b@x" },
      },
      atomic: <T>(fn: () => T) => fn(),
      tickets: {
        get: (id: string) => tickets.find((t) => t.id === id),
        open: () => tickets.filter((t) => !t.ended),
        bindThread: (id: string, thread: { source: string; id: string }, own: boolean) => {
          bound.push({ id, thread: `${thread.source}:${thread.id}`, own });
        },
        threadClosed: (thread: { source: string; id: string }, outcome: string, at: string) => {
          closed.push({ thread: `${thread.source}:${thread.id}`, outcome, at });
        },
      },
      triggers: {
        get: (id: string) => triggers[id],
      },
      threads: {
        describe: (key: string, desc: { facts?: unknown }) =>
          described.push({ key, facts: desc.facts }),
        patch: (key: string, meta: Record<string, unknown>) => patched.push({ key, meta }),
      },
    } as unknown as SourceContext;
    return { ctx, bound, closed, described, patched };
  }

  it("claims agent-opened or source PRs and rejects unrelated or conflicting PRs", async () => {
    const ticket = makeTicket();
    const other = makeTicket({
      id: "tk-2",
      follows: [{ thread: "github:42", own: true }],
      execution: { name: "other", directory: "/tmp/o", assignment: "other" },
    });
    const { ctx, bound } = mockContext([ticket]);
    expect(agentPull(makePull(), ctx.deployment)).toBe(true);
    expect(ticketBranch(ticket, "agent/fix-bug")).toBe(true);

    // Rejects unrelated PR
    expect(
      claimPull(
        ctx,
        ticket.id,
        makePull({
          number: 99,
          head: { sha: "a", ref: "unrelated", repo: { full_name: "owner/repo" } },
        }),
      ),
    ).toMatch(/does not belong/);

    // Binds matching agent PR
    expect(claimPull(ctx, ticket.id, makePull())).toBeUndefined();
    expect(bound).toEqual([{ id: "tk-1", thread: "github:42", own: true }]);

    // Rejects PR already claimed by another open ticket
    const conflict = mockContext([ticket, other]);
    expect(claimPull(conflict.ctx, ticket.id, makePull())).toMatch(/another active ticket/);
  });

  it("observes PR open/auto-merge/close transitions and emits localized terminal IM notices", async () => {
    const ticket = makeTicket();
    const openEnv = mockContext([ticket]);
    await expect(
      observePull(openEnv.ctx, makePull({ auto_merge: { enabled_by: "alice" } })),
    ).resolves.toBe(false);
    expect(openEnv.bound).toHaveLength(1);
    expect(openEnv.described[0]?.facts).toMatchObject({ autoMerge: { value: { en: "on" } } });

    const boundTicket = makeTicket({
      follows: [{ thread: "github:42", own: true }],
    });
    const closeEnv = mockContext([boundTicket]);
    await expect(
      observePull(
        closeEnv.ctx,
        makePull({ state: "closed", merged: true, merged_at: "2026-01-02T00:00:00.000Z" }),
      ),
    ).resolves.toBe(true);
    expect(closeEnv.closed).toEqual([
      { thread: "github:42", outcome: "merged", at: "2026-01-02T00:00:00.000Z" },
    ]);

    const endedTicket = makeTicket({
      ended: { at: "2026-01-02T00:00:00.000Z", by: "executor", outcome: "merged" },
      follows: [
        {
          thread: "github:10",
          own: false,
          closed: { at: "2026-01-02T00:00:00.000Z", outcome: "merged" },
        },
        {
          thread: "github:42",
          own: true,
          closed: { at: "2026-01-01T00:00:00.000Z", outcome: "merged" },
        },
      ],
      channels: [
        { source: "github", thread: "github:42", address: { number: "42" } },
        { source: "im", thread: "im:ops", address: { channel: "ops" } },
      ],
    });
    expect(pullsOf(endedTicket)).toEqual([10, 42]);
    expect(pullOf(endedTicket)).toBe(42);
    const zh = pullEndNotices(endedTicket, "请修复这个问题", "owner/repo");
    expect(zh).toHaveLength(1);
    expect(zh[0]?.text).toContain("PR #42");
    expect(zh[0]?.text).toContain("已合并");
    const en = pullEndNotices(endedTicket, "日本語テスト", "owner/repo");
    expect(en[0]?.text).toContain("has merged");
  });
});

describe("poll helpers", () => {
  it("evaluates poll horizon, cursor overlap, per-thread error isolation, and abortable pause", async () => {
    const now = Date.parse("2026-02-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recentThread: Thread = {
      key: "github:1",
      ref: { source: "github", id: "1" },
      createdAt: "2026-01-30T00:00:00.000Z",
      subscriptions: ["tk-ended"],
      correlated: [],
      pending: [],
      meta: {},
    };
    const okThread: Thread = {
      ...recentThread,
      key: "github:3",
      ref: { source: "github", id: "3" },
    };
    const staleThread: Thread = {
      ...recentThread,
      key: "github:2",
      ref: { source: "github", id: "2" },
      createdAt: "2026-01-01T00:00:00.000Z",
      subscriptions: [],
    };
    const patches: { key: string; meta: Record<string, unknown> }[] = [];
    const ctx = {
      tickets: {
        get: (id: string) =>
          id === "tk-ended"
            ? makeTicket({
                id,
                ended: { at: "2026-01-25T00:00:00.000Z", by: "executor", outcome: "completed" },
              })
            : undefined,
      },
      threads: {
        subscribed: () => [recentThread, staleThread, okThread],
        patch: (key: string, meta: Record<string, unknown>) => patches.push({ key, meta }),
      },
    } as unknown as SourceContext;

    expect(polled(ctx, recentThread, now)).toBe(true);
    const staleAt = Date.parse(staleThread.createdAt);
    expect(polled(ctx, staleThread, staleAt + POLL_HORIZON_MS - 1000)).toBe(true);
    expect(polled(ctx, staleThread, now)).toBe(false);
    expect(cursorAt("2026-02-01T00:00:10.000Z")).toBe("2026-02-01T00:00:05.000Z");

    await pollThreads(
      ctx,
      "github",
      () => false,
      async (thread) => {
        if (thread.key === "github:1") throw new Error("rate limited");
      },
      (thread) => thread.key === "github:2",
    );
    expect(patches).toEqual([
      { key: "github:1", meta: { pollError: "Error: rate limited" } },
      { key: "github:3", meta: { pollError: undefined } },
    ]);

    const controller = new AbortController();
    const waiting = pause(60_000, controller.signal);
    controller.abort();
    await waiting;
    await pause(60_000, controller.signal);
  });
});
