import { logger } from "./logger";

/**
 * One outbound request, and a sentence for the case where it never arrives.
 *
 * `fetch` throws `TypeError: fetch failed` for everything that goes wrong below
 * HTTP - no DNS answer, no route out, a refused connection, a proxy that
 * dropped it, a certificate the runtime will not accept. That bare message is
 * what used to reach an outbox row, an administration screen and the log, and
 * it names neither what broke nor where to look, while those causes have
 * entirely different fixes: one is DNS, one is a firewall, one is TLS
 * interception.
 *
 * Node puts the answer in `cause.code`. It is a symbolic constant rather than
 * free text, so it is safe to carry into a message, and it is the one thing
 * that separates the three.
 *
 * Shared rather than copied: mail and single sign-on both talk to Microsoft
 * from this server, they fail in exactly these ways, and an administrator
 * chasing "notices stopped arriving" and one chasing "nobody can sign in" are
 * looking for the same sentence about the same network.
 */
export async function reach(
  url: string,
  init: RequestInit | undefined,
  /** Named in the log line, so the two callers stay tellable apart. */
  event: string
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error: unknown) {
    let host = "Microsoft";
    try {
      host = new URL(url).host;
    } catch {
      /* a URL built from constants, but never let this mask the real fault */
    }

    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : "";

    const sentence =
      code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? `This server cannot look up ${host}. Check its DNS.`
        : code === "ECONNREFUSED"
          ? `${host} refused the connection from this server.`
          : code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT"
            ? `This server could not reach ${host} before the connection timed out. Check its internet access and any outbound firewall or proxy.`
            : code.startsWith("CERT_") ||
                code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
                code === "SELF_SIGNED_CERT_IN_CHAIN" ||
                code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
              ? `The TLS certificate ${host} presented was not accepted. Something on this network is intercepting the connection.`
              : `This server could not reach ${host}. The request never got a reply.`;

    logger.error(event, { host, code });
    // The original is kept as the cause: the sentence is for the person, and
    // the stack underneath it is for whoever reads the log.
    throw new Error(code ? `${sentence} (${code})` : sentence, { cause: error });
  }
}
