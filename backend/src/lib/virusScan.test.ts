import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNoMalware, scanBytes, scannerConfig } from "./virusScan";

/**
 * A stand-in clamd on a local port. It reads the INSTREAM framing the way
 * clamd does - command, length-prefixed chunks, a zero-length end - so a
 * framing mistake here is one a real scanner would reject too.
 */

type Reply = (received: Buffer) => string | null;

let server: Server;
let port: number;
let received: Buffer[];
let reply: Reply;

function parseInstream(data: Buffer): { command: string; body: Buffer; complete: boolean } {
  const commandEnd = data.indexOf(0);
  if (commandEnd === -1) return { command: "", body: Buffer.alloc(0), complete: false };

  const command = data.toString("latin1", 0, commandEnd);
  const chunks: Buffer[] = [];
  let offset = commandEnd + 1;

  while (offset + 4 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length === 0) return { command, body: Buffer.concat(chunks), complete: true };
    if (offset + 4 + length > data.length) break;
    chunks.push(data.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }

  return { command, body: Buffer.concat(chunks), complete: false };
}

beforeEach(async () => {
  received = [];
  reply = () => "stream: OK\0";
  server = createServer((socket: Socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const parsed = parseInstream(data);
      if (!parsed.complete) return;
      received.push(parsed.body);
      expect(parsed.command).toBe("zINSTREAM");
      const answer = reply(parsed.body);
      if (answer === null) return; // say nothing, to time the caller out
      socket.end(answer);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(port);
  delete process.env.CLAMAV_TIMEOUT_MS;
});

afterEach(async () => {
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
  delete process.env.CLAMAV_TIMEOUT_MS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const config = () => ({ host: "127.0.0.1", port, timeoutMs: 2000 });

describe("scannerConfig", () => {
  it("is off when no host is set, which is how every installation starts", () => {
    delete process.env.CLAMAV_HOST;
    expect(scannerConfig()).toBeNull();
  });

  it("defaults the port to clamd's", () => {
    delete process.env.CLAMAV_PORT;
    expect(scannerConfig()).toEqual({ host: "127.0.0.1", port: 3310, timeoutMs: 30000 });
  });

  it("refuses a port that is not one", () => {
    process.env.CLAMAV_PORT = "clamd";
    expect(() => scannerConfig()).toThrow("CLAMAV_PORT must be a port number");
  });
});

describe("scanBytes", () => {
  it("sends every byte, in chunks, and reads a clean answer", async () => {
    // Bigger than one chunk, so the framing across chunks is exercised.
    const upload = Buffer.alloc(200 * 1024, 0x41);
    await expect(scanBytes(upload, config())).resolves.toEqual({ clean: true });
    expect(received[0].equals(upload)).toBe(true);
  });

  it("reads a detection and the signature it names", async () => {
    reply = () => "stream: Eicar-Test-Signature FOUND\0";
    await expect(scanBytes(Buffer.from("x"), config())).resolves.toEqual({
      clean: false,
      signature: "Eicar-Test-Signature",
    });
  });

  it("does not read an answer it does not recognise as clean", async () => {
    reply = () => "INSTREAM size limit exceeded. ERROR\0";
    await expect(scanBytes(Buffer.from("x"), config())).rejects.toThrow(
      "answered something unexpected"
    );
  });

  it("gives up on a scanner that never answers", async () => {
    reply = () => null;
    await expect(
      scanBytes(Buffer.from("x"), { ...config(), timeoutMs: 200 })
    ).rejects.toThrow("did not answer in time");
  });
});

describe("assertNoMalware", () => {
  it("does nothing at all when no scanner is set up", async () => {
    delete process.env.CLAMAV_HOST;
    await expect(assertNoMalware(Buffer.from("x"), "The memo file", "u1")).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it("lets a clean file through", async () => {
    await expect(assertNoMalware(Buffer.from("x"), "The memo file", "u1")).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it("refuses a file the scanner flags, naming the file", async () => {
    reply = () => "stream: Win.Trojan.Agent FOUND\0";
    await expect(
      assertNoMalware(Buffer.from("x"), '"budget.xlsx"', "u1")
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "MALWARE_FOUND",
      message: expect.stringContaining('"budget.xlsx" was refused'),
    });
  });

  it("refuses the upload when a configured scanner cannot be reached", async () => {
    // Fail closed: a scanner skipped whenever it is down only has to be
    // knocked over.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.CLAMAV_PORT = String(port); // the old port, now closed
    await expect(
      assertNoMalware(Buffer.from("x"), "The memo file", "u1")
    ).rejects.toMatchObject({ statusCode: 503, code: "VIRUS_SCAN_UNAVAILABLE" });
  });
});
