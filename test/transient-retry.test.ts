// A busy API is not a failed run.
//
// Growth-Strategy is weekly. On 2026-09-06 it failed outright with
// `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},
// "request_id":"req_011Cemut..."}` and lost the tick. Nothing about the request
// was wrong; the API was busy for a moment.
//
// The reason it was not retried is the interesting part, and it is a cost of a
// decision made earlier for a good reason. Every call here is streamed, because
// a non-streaming call long enough to matter gets cut at the edge with a 524
// after the model has already been paid. But the SDK's own retries wrap the
// HTTP handshake, and an overload that lands once the stream is open does not
// fail the handshake: it arrives as an error event inside a 200 response. So
// the SDK has nothing left to retry, and the caller gets the throw.
//
// These tests hold both halves: the busy case is retried, and the cases where
// retrying is wrong are not.

import { describe, expect, it, vi, afterEach } from "vitest";
import { Claude, ModelError, isTransientApiFailure } from "../src/lib/claude.js";
import { MODELS } from "../src/core/models.js";
import type { Env } from "../src/env.js";

/** An SDK error carrying an HTTP status, the way a failed handshake arrives. */
function withStatus(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** The mid-stream shape: no status, the payload itself as the message. */
const OVERLOADED_MID_STREAM = new Error(
  '{"type":"error","error":{"details":null,"type":"overloaded_error",' +
    '"message":"Overloaded"},"request_id":"req_011CemutaipS44i9boKuuZLW"}'
);

/**
 * A Claude whose transport fails a given number of times before answering.
 *
 * create() is stubbed as a throw for the same reason it is everywhere else in
 * this suite: both forms take identical parameters, so a typecheck cannot tell
 * a streamed call from a non-streamed one and only a stub can.
 */
function stubbed(failures: Error[]) {
  const claude = new Claude({
    ANTHROPIC_API_KEY: "test-key",
    SUPABASE_URL: "https://example.supabase.co",
  } as unknown as Env);

  let sends = 0;
  (claude as unknown as { client: unknown }).client = {
    messages: {
      create: async () => {
        throw new Error("model calls must be streamed, not created");
      },
      stream: () => ({
        finalMessage: async () => {
          const failure = failures[sends];
          sends += 1;
          if (failure) throw failure;
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "the answer" }],
            usage: { input_tokens: 10, output_tokens: 10 },
          };
        },
      }),
    },
  };

  return { claude, sends: () => sends };
}

/**
 * Run a call to completion with the backoff waits simulated rather than waited.
 *
 * The real backoff is eleven seconds across three retries. Advancing fake
 * timers asynchronously flushes the microtasks between them, so the retry loop
 * makes real progress without the suite sitting still for it.
 */
async function settle<T>(work: Promise<T>): Promise<T> {
  const outcome = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await vi.advanceTimersByTimeAsync(60_000);
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a call that fails because the API is busy", () => {
  it("is re-sent, and the run carries on", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { claude, sends } = stubbed([OVERLOADED_MID_STREAM, OVERLOADED_MID_STREAM]);

    const result = await settle(
      claude.complete({ system: "s", user: "u", model: MODELS.reasoning })
    );

    // Asserted on the number of sends, not only on the answer: an answer alone
    // cannot tell "retried twice and succeeded" from "succeeded first time".
    expect(sends()).toBe(3);
    expect(result.text).toBe("the answer");
  });

  it("is re-sent when the overload arrives as a status instead", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { claude, sends } = stubbed([withStatus(529, "Overloaded")]);

    const result = await settle(
      claude.complete({ system: "s", user: "u", model: MODELS.reasoning })
    );

    expect(sends()).toBe(2);
    expect(result.text).toBe("the answer");
  });

  it("gives up rather than hammering, and says what stopped it", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forever = Array.from({ length: 20 }, () => OVERLOADED_MID_STREAM);
    const { claude, sends } = stubbed(forever);

    await expect(
      settle(claude.complete({ system: "s", user: "u", model: MODELS.reasoning }))
    ).rejects.toBeInstanceOf(ModelError);

    // One first attempt plus MAX_TRANSIENT_RETRIES. A retry budget that quietly
    // grew would be a Worker spending its wall clock on a wall.
    expect(sends()).toBe(4);
  });
});

describe("a call that fails because the request is wrong", () => {
  it("is not re-sent, because the answer would be the same rejection", async () => {
    vi.useFakeTimers();
    const { claude, sends } = stubbed([
      withStatus(400, "output_config.format.schema: 'maxItems' is not supported"),
    ]);

    await expect(
      settle(claude.complete({ system: "s", user: "u", model: MODELS.reasoning }))
    ).rejects.toBeInstanceOf(ModelError);

    expect(sends()).toBe(1);
  });

  it("does not re-send a 524, because that one has already been paid for", async () => {
    vi.useFakeTimers();
    // A 524 is a 5xx and every instinct says retry it. It is excluded on
    // purpose: it arrives AFTER the model did the work and billed for it, so a
    // retry buys the same answer a second time at full price. This is why the
    // transient list is explicit rather than "any 5xx".
    const { claude, sends } = stubbed([withStatus(524, "524 error code: 524")]);

    await expect(
      settle(claude.complete({ system: "s", user: "u", model: MODELS.reasoning }))
    ).rejects.toBeInstanceOf(ModelError);

    expect(sends()).toBe(1);
  });
});

describe("which failures count as the API being busy", () => {
  it("counts overload, rate limiting and a dropped connection", () => {
    expect(isTransientApiFailure(OVERLOADED_MID_STREAM)).toBe(true);
    expect(isTransientApiFailure(withStatus(429, "rate limited"))).toBe(true);
    expect(isTransientApiFailure(withStatus(503, "unavailable"))).toBe(true);
    expect(
      isTransientApiFailure(Object.assign(new Error("Connection error."), {
        name: "APIConnectionError",
      }))
    ).toBe(true);
    expect(isTransientApiFailure(new Error('{"type":"error","error":{"type":"api_error"}}'))).toBe(
      true
    );
  });

  it("counts nothing that describes our own request", () => {
    expect(isTransientApiFailure(withStatus(400, "bad schema"))).toBe(false);
    expect(isTransientApiFailure(withStatus(401, "bad key"))).toBe(false);
    expect(isTransientApiFailure(withStatus(404, "no such model"))).toBe(false);
    expect(isTransientApiFailure(withStatus(524, "edge timeout"))).toBe(false);
    expect(isTransientApiFailure(new Error("Ran out of output budget"))).toBe(false);
  });
});
