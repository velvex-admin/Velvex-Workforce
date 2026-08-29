// The LinkedIn partner queue filled with one post repeated on every hourly
// tick, and would have had the partner publish every copy.
//
// The cause was one early return. The strategist hands a draft to the queue,
// and when the partner is not wired up yet that handover reported
// `blocked_inactive` and returned immediately — before stamping the draft as
// handed over, and before consuming the schedule slot that asked for it. Both
// of those are what stop the next run doing it again, and the third guard, the
// minimum gap between posts, counts only `executed` reports and so never
// engaged either. Three guards, all skipped by the same return.
//
// These tests cover the connector half: the queue refuses to hold the same work
// twice, and repairs a queue that already does.

import { describe, expect, it } from "vitest";
import {
  collectQueue,
  compactQueue,
  dedupeQueue,
  enqueueForPartner,
  queueIdentity,
  type LinkedInQueueItem,
} from "../src/connectors/linkedin.js";
import type { Supabase } from "../src/lib/supabase.js";

/**
 * A memory table that behaves like the real one for the two calls this
 * connector makes: writes upsert on key, reads filter by key.
 */
function fakeDb(): Supabase & { writes: number } {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    writes: 0,
    async writeMemory(row: { key: string; detail?: Record<string, unknown> }) {
      db.writes += 1;
      rows.set(row.key, row as Record<string, unknown>);
      return row;
    },
    async readMemory(opts: { keys?: string[] } = {}) {
      const key = opts.keys?.[0];
      const row = key ? rows.get(key) : undefined;
      return row ? [row] : [];
    },
  };
  return db as unknown as Supabase & { writes: number };
}

const item = (over: Partial<LinkedInQueueItem>): LinkedInQueueItem => ({
  id: crypto.randomUUID(),
  text: "The diagnostic names the constraint, not the symptom.",
  createdAt: "2026-08-20T10:00:00Z",
  status: "queued",
  ...over,
});

describe("queueIdentity", () => {
  it("prefers the caller's key, so re-worded copy is still the same work", () => {
    const a = { text: "one wording", sourceKey: "draft-7" };
    const b = { text: "a different wording entirely", sourceKey: "draft-7" };
    expect(queueIdentity(a)).toBe(queueIdentity(b));
  });

  it("falls back to text for rows queued before keys existed", () => {
    expect(queueIdentity({ text: "Same  post\n" })).toBe(queueIdentity({ text: "same post" }));
    expect(queueIdentity({ text: "one post" })).not.toBe(queueIdentity({ text: "another post" }));
  });

  it("does not merge two different posts that happen to share a key-less text prefix", () => {
    expect(queueIdentity({ text: "opening line" })).not.toBe(
      queueIdentity({ text: "opening line, continued" })
    );
  });
});

describe("dedupeQueue", () => {
  it("collapses the repeated post to one", () => {
    const repeats = [
      item({ createdAt: "2026-08-20T13:00:00Z" }),
      item({ createdAt: "2026-08-20T12:00:00Z" }),
      item({ createdAt: "2026-08-20T11:00:00Z" }),
      item({ createdAt: "2026-08-20T10:00:00Z" }),
    ];
    const kept = dedupeQueue(repeats);
    expect(kept).toHaveLength(1);
    // The original, not the newest copy of it: that is the one whose age says
    // how long the partner has had work waiting.
    expect(kept[0]!.createdAt).toBe("2026-08-20T10:00:00Z");
  });

  it("leaves genuinely different posts alone", () => {
    const items = [item({ text: "first post" }), item({ text: "second post" })];
    expect(dedupeQueue(items)).toHaveLength(2);
  });

  it("never drops what the partner already took", () => {
    const published = item({ status: "published", publishedRef: "urn:li:share:1" });
    const stillQueued = item({ createdAt: "2026-08-20T11:00:00Z" });
    const kept = dedupeQueue([stillQueued, published]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.status).toBe("published");
  });

  it("keeps a collected row and drops the queued repeat behind it", () => {
    const collected = item({ status: "collected", createdAt: "2026-08-20T10:00:00Z" });
    const repeat = item({ createdAt: "2026-08-20T14:00:00Z" });
    const kept = dedupeQueue([repeat, collected]);
    expect(kept.map((row) => row.status)).toEqual(["collected"]);
  });
});

describe("enqueueForPartner", () => {
  it("adds the first handover", async () => {
    const db = fakeDb();
    const result = await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
    expect(result.duplicate).toBe(false);
    expect(await collectQueue(db, false)).toHaveLength(1);
  });

  it("does not add a second row for the same draft, however many ticks pass", async () => {
    const db = fakeDb();
    const first = await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
    for (let tick = 0; tick < 12; tick += 1) {
      const again = await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
      expect(again.duplicate).toBe(true);
      expect(again.item.id).toBe(first.item.id);
    }
    expect(await collectQueue(db, false)).toHaveLength(1);
  });

  it("treats re-worded copy for the same draft as the same work", async () => {
    const db = fakeDb();
    await enqueueForPartner(db, { text: "first wording", sourceKey: "draft-1" });
    const again = await enqueueForPartner(db, { text: "second wording", sourceKey: "draft-1" });
    expect(again.duplicate).toBe(true);
    expect(await collectQueue(db, false)).toHaveLength(1);
  });

  it("still accepts a genuinely different draft", async () => {
    const db = fakeDb();
    await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
    const other = await enqueueForPartner(db, { text: "another post", sourceKey: "draft-2" });
    expect(other.duplicate).toBe(false);
    expect(await collectQueue(db, false)).toHaveLength(2);
  });

  it("writes nothing when the handover is a repeat", async () => {
    const db = fakeDb();
    await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
    const writesAfterFirst = db.writes;
    await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
    expect(db.writes).toBe(writesAfterFirst);
  });
});

describe("compactQueue", () => {
  it("repairs a queue that filled up before the strategist was fixed", async () => {
    const db = fakeDb();
    // Written straight into the table, the way the old code left it: no source
    // keys, one post, four rows.
    await db.writeMemory({
      key: "linkedin.outbound_queue",
      detail: {
        items: [
          item({ createdAt: "2026-08-20T13:00:00Z" }),
          item({ createdAt: "2026-08-20T12:00:00Z" }),
          item({ createdAt: "2026-08-20T11:00:00Z" }),
          item({ createdAt: "2026-08-20T10:00:00Z" }),
        ],
      },
    } as never);

    const result = await compactQueue(db);
    expect(result.removed).toBe(3);
    expect(result.waiting).toBe(1);
    expect(await collectQueue(db, false)).toHaveLength(1);
  });

  it("is a no-op on a clean queue, and says so", async () => {
    const db = fakeDb();
    await enqueueForPartner(db, { text: "a post", sourceKey: "draft-1" });
    await enqueueForPartner(db, { text: "another post", sourceKey: "draft-2" });
    expect((await compactQueue(db)).removed).toBe(0);
  });
});

describe("collectQueue", () => {
  it("never hands the partner the same post twice", async () => {
    const db = fakeDb();
    await db.writeMemory({
      key: "linkedin.outbound_queue",
      detail: {
        items: [
          item({ createdAt: "2026-08-20T12:00:00Z" }),
          item({ createdAt: "2026-08-20T11:00:00Z" }),
          item({ text: "a different post", createdAt: "2026-08-20T10:00:00Z" }),
        ],
      },
    } as never);

    const collected = await collectQueue(db);
    expect(collected).toHaveLength(2);
    // And what it took is marked, so a second collection returns nothing.
    expect(await collectQueue(db)).toHaveLength(0);
  });
});
