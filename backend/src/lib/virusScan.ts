import { connect } from "node:net";
import { AppError, errors } from "./errors";
import { logger } from "./logger";

/**
 * Scans an upload with ClamAV before it is filed, when a scanner is set up.
 *
 * Memos and their attachments are opened by every approver in the chain, so a
 * file one person uploads reaches a dozen machines. The content check in
 * `fileContent.ts` stops a file pretending to be another type; it cannot see
 * a macro in a real Word document or an exploit in a real PDF. That needs a
 * scanner, and a scanner is infrastructure this application cannot bring
 * with it - so it talks to a clamd the organisation runs, over clamd's own
 * INSTREAM protocol, and needs no package to do it.
 *
 * With CLAMAV_HOST unset nothing is scanned, which is the state every
 * installation was in before this. With it set, the scanner is required: an
 * upload it cannot vouch for - unreachable, timed out, an answer it does not
 * recognise - is refused rather than let through, because a scanner that is
 * skipped whenever it is down is one an attacker only has to knock over.
 */

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 30_000;
/** clamd reads INSTREAM in chunks; this is well inside its default limits. */
const CHUNK_BYTES = 64 * 1024;

export type ScannerConfig = { host: string; port: number; timeoutMs: number };

export function scannerConfig(): ScannerConfig | null {
  const host = process.env.CLAMAV_HOST?.trim();
  if (!host) return null;

  const port = Number(process.env.CLAMAV_PORT?.trim() || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CLAMAV_PORT must be a port number");
  }

  const timeoutMs = Number(
    process.env.CLAMAV_TIMEOUT_MS?.trim() || DEFAULT_TIMEOUT_MS
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("CLAMAV_TIMEOUT_MS must be a whole number of milliseconds");
  }

  return { host, port, timeoutMs };
}

export type ScanVerdict = { clean: true } | { clean: false; signature: string };

/**
 * One INSTREAM exchange: the command, the bytes in length-prefixed chunks,
 * a zero-length chunk to end, then a single reply such as `stream: OK` or
 * `stream: Eicar-Test-Signature FOUND`.
 */
export function scanBytes(bytes: Buffer, config: ScannerConfig): Promise<ScanVerdict> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    const reply: Buffer[] = [];
    let settled = false;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      outcome();
    };

    socket.setTimeout(config.timeoutMs, () =>
      finish(() => reject(new Error("The virus scanner did not answer in time")))
    );
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk) =>
      reply.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    );
    socket.on("end", () =>
      finish(() => {
        const text = Buffer.concat(reply).toString("utf8").replace(/\0/g, "").trim();
        const answer = text.replace(/^stream:\s*/, "");

        if (answer === "OK") return resolve({ clean: true });

        const found = /^(.+) FOUND$/.exec(answer);
        if (found) return resolve({ clean: false, signature: found[1] });

        reject(new Error(`The virus scanner answered something unexpected: ${text}`));
      })
    );

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

/**
 * Refuses the upload if the scanner finds something, or cannot say.
 *
 * @param label How the refusal names the file, e.g. `"budget.xlsx"`.
 */
export async function assertNoMalware(
  bytes: Buffer,
  label: string,
  actorId: string | undefined
): Promise<void> {
  const config = scannerConfig();
  if (!config) return;

  let verdict: ScanVerdict;
  try {
    verdict = await scanBytes(bytes, config);
  } catch (error) {
    logger.error("upload.scan_failed", { err: error, actorId });
    throw new AppError(
      503,
      "Uploaded files are checked for viruses, and the checker is not " +
        "answering just now, so nothing was saved. Try again in a few " +
        "minutes; if it keeps happening, tell your administrator.",
      "VIRUS_SCAN_UNAVAILABLE"
    );
  }

  if (!verdict.clean) {
    // The signature name is what the scanner matched, not anything from the
    // file, so it is safe to log; the file name is content and is not.
    // Logged as `detection`: the logger redacts any field called `signature`.
    logger.warn("upload.malware_refused", { actorId, detection: verdict.signature });
    throw errors.badRequest(
      `${label} was refused because the virus checker found something ` +
        "harmful in it. Nothing was saved. Do not open that copy; tell your " +
        "IT team where it came from.",
      "MALWARE_FOUND"
    );
  }
}
