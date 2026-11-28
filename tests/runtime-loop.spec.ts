import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import {
  reasonText,
  said,
  ticketStage,
  canRetry,
  type Engine,
  type OutboundMessage,
  type Ticket,
  type Trigger,
} from "../src/core/index.ts";
import { executable, noreplyEmail, resolveAccount } from "../src/config.ts";
import { CliError, Commands, commandError, validItems } from "../src/infra/commands.ts";
import { HealthBoard } from "../src/infra/health.ts";
import {
  checkedImText,
  escapeRegExp,
  fill,
  IM_WORDS,
  sameName,
  wordCount,
} from "../src/infra/text.ts";
import { Effects } from "../src/runtime/effects.ts";
import { Outbox } from "../src/runtime/outbox.ts";
import { Passes } from "../src/runtime/passes.ts";
import { Store } from "../src/store/store.ts";

const dirs: string[] = [];
function tempDir(prefix = "runtime-loop-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const baseTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "t1",
  title: "Task",
  decisionId: "d1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  mandate: {
    strength: "explicit",
    policyVersion: "v1",
    actor: { source: "im", id: "alice" },
    scope: "Task",
    basis: { via: "addressed", addressed: "mention" },
  },
  channels: [],
  origin: { triggerId: "tr1", triggerIds: ["tr1"] },
  inputs: [],
  undelivered: [],
  assignments: [],
  ...overrides,
});

describe("Outbox", () => {
  const message = (id: string, ticketId = "t1", thread = "im:c1"): OutboundMessage => ({
    id,
    ticketId,
    channel: { source: "im", thread, address: { channel: thread } },
    text: `msg-${id}`,
    kind: "reply",
  });

  it("delivers queued messages once, tracks status, and ignores duplicate ids", async () => {
    const dir = tempDir();
    const store = new Store(join(dir, "state.sqlite"));
    const effects = new Effects(store, new HealthBoard());
    const sent: string[] = [];
    const commands = new Commands(
      () => ({ repository: "o/r", github: { cli: "gh", login: "bot", noreply: "b@x" } }),
      {},
      new AbortController().signal,
    );
    const outbox = new Outbox({
      store,
      effects,
      commands,
      stateDir: dir,
      paused: () => false,
      sources: {
        instance: ((id: string) => ({ id, kind: id, enabled: true, config: {} })) as never,
        channelAllowed: () => true,
        send: async (msg) => {
          sent.push(msg.id);
          return "sent";
        },
      },
    });
    outbox.send(message("m1"));
    outbox.send(message("m1"));
    expect(outbox.status("m1")).toBe("pending");
    effects.start();
    await outbox.sent();
    expect(sent).toEqual(["m1"]);
    expect(outbox.status("m1")).toBe("sent");
    await effects.drain();
    store.close();
  });

  it("settles as dropped when channel is disallowed or gone, and supports withdraw", async () => {
    const dir = tempDir();
    const store = new Store(join(dir, "state.sqlite"));
    const effects = new Effects(store, new HealthBoard());
    const commands = new Commands(
      () => ({ repository: "o/r", github: { cli: "gh", login: "bot", noreply: "b@x" } }),
      {},
      new AbortController().signal,
    );
    let allowed = true;
    const outbox = new Outbox({
      store,
      effects,
      commands,
      stateDir: dir,
      paused: () => false,
      sources: {
        instance: ((id: string) => ({ id, kind: id, enabled: true, config: {} })) as never,
        channelAllowed: () => allowed,
        send: async () => "gone",
      },
    });
    outbox.send(message("withdrawn"));
    outbox.withdraw("withdrawn");
    expect(outbox.status("withdrawn")).toBeUndefined();

    allowed = false;
    outbox.send(message("ignored"));
    effects.start();
    await outbox.sent();
    expect(outbox.status("ignored")).toBe("dropped");
    expect(store.receipts.get("ignored")?.dropped?.reason).toBe("channelIgnored");

    allowed = true;
    outbox.send(message("gone-msg"));
    await outbox.sent();
    expect(outbox.status("gone-msg")).toBe("dropped");
    expect(store.receipts.get("gone-msg")?.dropped?.reason).toBe("channelGone");
    await effects.drain();
    store.close();
  });

  it("holds messages while paused, source disabled, waiting, or behind an earlier pending message", async () => {
    const dir = tempDir();
    const store = new Store(join(dir, "state.sqlite"));
    let clock = 1000;
    const effects = new Effects(store, new HealthBoard(), () => clock);
    const commands = new Commands(
      () => ({ repository: "o/r", github: { cli: "gh", login: "bot", noreply: "b@x" } }),
      {},
      new AbortController().signal,
    );
    let paused = true;
    let enabled = false;
    let mode: "waiting" | "sent" = "waiting";
    const delivered: string[] = [];
    const outbox = new Outbox({
      store,
      effects,
      commands,
      stateDir: dir,
      paused: () => paused,
      sources: {
        instance: ((id: string) => ({ id, kind: id, enabled, config: {} })) as never,
        channelAllowed: () => true,
        send: async (msg) => {
          if (mode === "waiting") return "waiting";
          delivered.push(msg.id);
          return "sent";
        },
      },
    });
    outbox.send(message("m1", "t1", "im:c1"));
    outbox.send(message("m2", "t1", "im:c1"));
    effects.start();
    await effects.idle();
    expect(delivered).toEqual([]);

    // Unpause while source disabled -> held via Later
    paused = false;
    clock += 10_000;
    effects.kick();
    await effects.idle();
    expect(outbox.status("m1")).toBe("pending");

    // Enable source while send returns waiting -> held via Later
    enabled = true;
    clock += 10_000;
    effects.kick();
    await effects.idle();
    expect(outbox.status("m1")).toBe("pending");

    // Now allow sending -> both deliver in order
    mode = "sent";
    clock += 10_000;
    effects.kick();
    await outbox.sent();
    expect(delivered).toEqual(["m1", "m2"]);
    await effects.drain();
    store.close();
  });
});

describe("Passes", () => {
  it("coalesces concurrent pumps, reports/recovers health, and gates receive when closing", async () => {
    const board = new HealthBoard();
    const health = board.claim("passes");
    const controller = new AbortController();
    let configured = false;
    let closing = false;
    let failEvaluate = false;
    let kicks = 0;
    let evals = 0;
    const engine: Pick<Engine, "receive" | "evaluateDue"> = {
      receive: (trigger: Trigger) => (trigger.id === "dup" ? "duplicate" : "stored"),
      evaluateDue: () => {
        evals++;
        if (failEvaluate) throw new Error("boom");
      },
    };
    const passes = new Passes({
      engine,
      effects: {
        kick: () => {
          kicks++;
        },
        idle: async () => {},
      },
      health,
      lifetime: controller.signal,
      configured: () => configured,
      closing: () => closing,
    });

    // Unconfigured pump is a no-op
    await passes.pump();
    expect(kicks).toBe(0);

    configured = true;
    const p1 = passes.pump();
    const p2 = passes.pump();
    await Promise.all([p1, p2]);
    expect(kicks).toBe(2);
    expect(evals).toBe(2);

    // Failed pass sets error health; next successful pass recovers to ready
    failEvaluate = true;
    passes.request();
    await passes.idle();
    expect(health.get()?.state).toBe("error");

    failEvaluate = false;
    passes.receive({
      id: "t-new",
      source: "im",
      threads: [{ source: "im", id: "c" }],
      actor: { source: "im", id: "a" },
      human: true,
      at: "2026-01-01T00:00:00.000Z",
      text: "hi",
      meta: {},
    });
    await passes.idle();
    expect(health.get()?.state).toBe("ready");

    // Duplicate receive does not trigger extra pass
    const beforeEvals = evals;
    expect(
      passes.receive({
        id: "dup",
        source: "im",
        threads: [{ source: "im", id: "c" }],
        actor: { source: "im", id: "a" },
        human: true,
        at: "2026-01-01T00:00:00.000Z",
        text: "hi",
        meta: {},
      }),
    ).toBe("duplicate");
    expect(evals).toBe(beforeEvals);

    // Periodic timer + stop/closing
    vi.useFakeTimers();
    passes.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(evals).toBeGreaterThan(beforeEvals);
    closing = true;
    expect(() =>
      passes.receive({
        id: "t-closed",
        source: "im",
        threads: [{ source: "im", id: "c" }],
        actor: { source: "im", id: "a" },
        human: true,
        at: "2026-01-01T00:00:00.000Z",
        text: "hi",
        meta: {},
      }),
    ).toThrow(/stopping/);
    await passes.stop();
  });
});

describe("config & infra helpers", () => {
  it("resolves executables on PATH while skipping excluded dirs and non-executables", async () => {
    const dir = tempDir("cfg-");
    const excluded = join(dir, "excluded");
    const bin = join(dir, "bin");
    const empty = tempDir("cfg-empty-");
    rmSync(empty, { recursive: true, force: true });
    const execPath = join(bin, "mytool");
    const nonExecDir = join(dir, "nonexec");
    mkdirSyncSafe(excluded);
    mkdirSyncSafe(bin);
    mkdirSyncSafe(nonExecDir);
    writeFileSync(join(excluded, "mytool"), "#!/bin/sh\necho excluded\n");
    chmodSync(join(excluded, "mytool"), 0o755);
    writeFileSync(join(nonExecDir, "mytool"), "not-exec");
    writeFileSync(execPath, "#!/bin/sh\necho ok\n");
    chmodSync(execPath, 0o755);

    const pathEnv = [excluded, nonExecDir, bin].join(delimiter);
    expect(executable("mytool", pathEnv, excluded)).toBe(execPath);
    expect(executable(execPath, "")).toBe(execPath);
    expect(() => executable("rel/mytool", pathEnv)).toThrow(/command name or an absolute path/);
    expect(() => executable("missing-tool", pathEnv)).toThrow(/not an executable file on PATH/);
    expect(() => executable("/no/such/file", pathEnv)).toThrow(/not an executable file$/);
    expect(noreplyEmail("alice")).toBe("alice@users.noreply.github.com");
    expect(noreplyEmail("alice", 42)).toBe("42+alice@users.noreply.github.com");

    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, '#!/bin/sh\necho \'{"login":"octocat","id":7}\'\n');
    chmodSync(fakeGh, 0o755);
    await expect(resolveAccount(fakeGh)).resolves.toEqual({
      login: "octocat",
      id: 7,
      noreply: "7+octocat@users.noreply.github.com",
    });

    const badGh = join(bin, "bad-gh");
    writeFileSync(badGh, '#!/bin/sh\necho "{}"\n');
    chmodSync(badGh, 0o755);
    await expect(resolveAccount(badGh)).rejects.toThrow(/not signed in/);

    const errGh = join(bin, "err-gh");
    writeFileSync(errGh, "#!/bin/sh\nexit 1\n");
    chmodSync(errGh, 0o755);
    await expect(resolveAccount(errGh)).rejects.toThrow(/Cannot read the account/);
  });

  it("classifies subprocess errors, validates items, and enforces Commands repo boundary", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(commandError(abort)).toBe(abort);

    const jsonErr = commandError({
      code: 1,
      stderr: 'warning\n{"error":{"code":422,"message":"Validation Failed"}}',
    }) as CliError;
    expect(jsonErr).toBeInstanceOf(CliError);
    expect(jsonErr.code).toBe(422);
    expect(jsonErr.message).toContain("Validation Failed");

    const httpErr = commandError({ code: 1, stderr: "gh: Not Found (HTTP 404)" }) as CliError;
    expect(httpErr.code).toBe(404);

    expect(
      commandError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "/bin/git").message,
    ).toContain("more output");
    expect(commandError({ killed: true, signal: "SIGTERM" }, "/bin/git").message).toContain(
      "timed out",
    );
    expect(commandError({ signal: "SIGKILL" }, "/bin/git").message).toContain("SIGKILL");
    expect(commandError({ code: 128 }, "/bin/git").message).toContain("exited with code 128");
    expect(commandError({ code: "ENOENT" }, "/bin/git").message).toContain("could not run: ENOENT");

    const tally = { skipped: 0 };
    expect(
      validItems(z.object({ n: z.number() }), [{ n: 1 }, { n: "bad" }, { n: 2 }], tally),
    ).toEqual([{ n: 1 }, { n: 2 }]);
    expect(tally.skipped).toBe(1);

    const commands = new Commands(
      () => ({ repository: "owner/repo", github: { cli: "gh", login: "bot", noreply: "b@x" } }),
      {},
      new AbortController().signal,
    );
    expect(commands.withSignal()).toBe(commands);
    expect(commands.withSignal(new AbortController().signal)).not.toBe(commands);
    await expect(commands.api("/users")).rejects.toThrow(/restricted to the configured repository/);
    await expect(commands.api("../other/issues")).rejects.toThrow(/restricted/);
    await expect(commands.api("https://evil.test")).rejects.toThrow(/restricted/);

    const noRepo = new Commands(
      () => ({ repository: "", github: { cli: "gh", login: "bot", noreply: "b@x" } }),
      {},
      new AbortController().signal,
    );
    await expect(noRepo.api("issues")).rejects.toThrow(/no GitHub repository/);
  });

  it("counts IM words, rejects oversized updates, and formats templates", () => {
    expect(wordCount("hello world, 中文测试！")).toBe(4);
    expect(checkedImText("short message")).toBe("short message");
    const overLimit = Array.from({ length: IM_WORDS + 1 }, (_, i) => `w${i}`).join(" ");
    expect(() => checkedImText(overLimit)).toThrow(/maximum is 100/);
    expect(fill("hello {name} {missing}", { name: "world" })).toBe("hello world ");
    expect(sameName("Owner/Repo", "owner/repo")).toBe(true);
    expect(escapeRegExp("a+b.(c)?")).toBe("a\\+b\\.\\(c\\)\\?");
  });

  it("formats reasons and classifies every ticketStage and canRetry state", () => {
    expect(
      reasonText([
        said("hello"),
        { code: "startedTicket", values: { ticket: "t1" }, triggerId: "tr1" },
        { code: "custom_reason" },
      ]),
    ).toBe("hello; tr1: Already started ticket t1; custom_reason");

    expect(
      ticketStage(
        baseTicket({
          ended: { at: "2026-01-01T00:01:00.000Z", by: "executor", outcome: "completed" },
        }),
      ),
    ).toEqual({ stage: "ended" });

    const deliveryBlocked = baseTicket({
      delivery: { error: "timeout", at: "2026-01-01T00:01:00.000Z" },
    });
    expect(ticketStage(deliveryBlocked)).toEqual({ stage: "person", action: "delivery" });
    expect(canRetry(deliveryBlocked)).toBe(true);

    expect(ticketStage(baseTicket({ attention: { id: "q1", question: "Why?" } }))).toEqual({
      stage: "person",
      action: "answer",
    });

    expect(
      ticketStage(
        baseTicket({
          assignments: [
            {
              id: "a1",
              state: "running",
              createdAt: "2026-01-01T00:00:00.000Z",
              report: { state: "ready", summary: "done", at: "2026-01-01T00:01:00.000Z" },
            },
          ],
        }),
      ),
    ).toEqual({ stage: "person", action: "review" });

    expect(
      ticketStage(
        baseTicket({
          assignments: [
            {
              id: "a1",
              state: "running",
              createdAt: "2026-01-01T00:00:00.000Z",
              report: { state: "blocked", summary: "need info", at: "2026-01-01T00:01:00.000Z" },
            },
          ],
        }),
      ),
    ).toEqual({ stage: "person", action: "blocked" });

    expect(ticketStage(baseTicket({ assignments: [] }))).toEqual({
      stage: "working",
      action: "queued",
    });
    expect(
      ticketStage(
        baseTicket({
          assignments: [{ id: "a1", state: "ended", createdAt: "2026-01-01T00:00:00.000Z" }],
        }),
      ),
    ).toEqual({ stage: "idle" });
    expect(
      ticketStage(
        baseTicket({
          assignments: [{ id: "a1", state: "running", createdAt: "2026-01-01T00:00:00.000Z" }],
        }),
      ),
    ).toEqual({ stage: "working" });
  });
});

import { mkdirSync } from "node:fs";
function mkdirSyncSafe(path: string): void {
  mkdirSync(path, { recursive: true });
}
