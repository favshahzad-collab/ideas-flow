import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stopping a job queue waits for the pass under way. The mail and deadline
 * queues are built the same way; this one stands for all three.
 */

const seal = vi.hoisted(() => ({ release: null as (() => void) | null, calls: 0 }));

vi.mock("../services/ledger.service", () => ({
  ledgerService: {
    seal: () => {
      seal.calls += 1;
      return new Promise<{ sealed: number }>((resolve) => {
        seal.release = () => resolve({ sealed: 0 });
      });
    },
  },
}));
vi.mock("./heartbeat", () => ({ registerJob: () => {}, reportJob: () => {} }));

import { startLedgerSealer, stopLedgerSealer } from "./ledgerQueue";

afterEach(async () => {
  seal.release?.();
  await stopLedgerSealer();
  seal.release = null;
  seal.calls = 0;
});

describe("stopLedgerSealer", () => {
  it("does not resolve until the seal that was running has finished", async () => {
    startLedgerSealer(); // starts one pass straight away
    expect(seal.calls).toBe(1);

    let stopped = false;
    const stopping = stopLedgerSealer().then(() => {
      stopped = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);

    seal.release!();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("resolves straight away when nothing is running", async () => {
    startLedgerSealer();
    seal.release!();
    await new Promise((r) => setTimeout(r, 0));

    await expect(stopLedgerSealer()).resolves.toBeUndefined();
  });

  it("starts no new pass once stopped", async () => {
    vi.useFakeTimers();
    try {
      startLedgerSealer();
      seal.release!();
      await stopLedgerSealer();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(seal.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
