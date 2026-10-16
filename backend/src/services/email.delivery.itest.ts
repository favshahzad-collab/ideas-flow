import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMailTransport } from "../lib/mailer";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { emailService } from "./email.service";

/*
 * Submitted, with the preparer's receipt taken out of the outbox: each test
 * here follows one notice onto the wire, and a second would be counted.
 */
async function submitWithoutReceipt(options: Parameters<typeof submitDocument>[0]) {
  const document = await submitDocument(options);
  await prisma.emailMessage.deleteMany({ where: { recipientId: options.preparerId } });
  return document;
}

/**
 * The wire.
 *
 * Every other test in this area mocks `sendMail`, which proves the queue and
 * proves nothing about whether this application can actually hand a message to
 * a mail server. So this one starts a real SMTP server - forty lines of it, in
 * process - points the real configuration at it, and reads back what arrived.
 *
 * What it catches is the class of bug no unit test can: a transport built with
 * the wrong options, a `from` that never leaves, a body that arrives empty.
 */

useCleanDatabase();

type Received = { from: string; to: string[]; data: string };

let server: net.Server;
let port: number;
let received: Received[];

/**
 * An SMTP server that accepts everything and remembers it.
 *
 * Enough of RFC 5321 for a client to complete a transaction: a greeting, a
 * capability list, an envelope, a body terminated by a lone dot, and goodbye.
 */
function startSink(): Promise<void> {
  received = [];

  server = net.createServer((socket) => {
    let message: Received = { from: "", to: [], data: "" };
    let readingBody = false;
    let buffer = "";

    socket.write("220 test.local ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      let newline = buffer.indexOf("\r\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        if (readingBody) {
          if (line === ".") {
            readingBody = false;
            received.push(message);
            message = { from: "", to: [], data: "" };
            socket.write("250 OK\r\n");
          } else {
            // A leading dot is doubled by the client; undo it.
            message.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
        } else {
          const upper = line.toUpperCase();

          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            socket.write("250-test.local\r\n250 8BITMIME\r\n");
          } else if (upper.startsWith("MAIL FROM:")) {
            message.from = line.slice("MAIL FROM:".length).trim();
            socket.write("250 OK\r\n");
          } else if (upper.startsWith("RCPT TO:")) {
            message.to.push(line.slice("RCPT TO:".length).trim());
            socket.write("250 OK\r\n");
          } else if (upper === "DATA") {
            readingBody = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (upper === "QUIT") {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }

        newline = buffer.indexOf("\r\n");
      }
    });

    socket.on("error", () => {
      // A client hanging up mid-transaction is not this test's business.
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

/**
 * The message as a mail client would read it.
 *
 * A body with a non-ASCII character in it - and every memo reference here is
 * joined to its title with an em dash - goes out quoted-printable: the em dash
 * arrives as `=E2=80=94` and any line past 76 characters is broken with a
 * trailing `=`, which is how a URL ends up cut in half on the wire. The header
 * carries the same thing as an RFC 2047 encoded word. Asserting on the raw
 * bytes would be asserting on the transfer encoding; this undoes it first.
 */
function decodeQuotedPrintable(text: string): Buffer {
  const unwrapped = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < unwrapped.length; index += 1) {
    const char = unwrapped[index];

    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(unwrapped.slice(index + 1, index + 3))) {
      bytes.push(parseInt(unwrapped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }

  return Buffer.from(bytes);
}

function readMessage(raw: string): string {
  const withHeaders = raw.replace(
    /=\?UTF-8\?Q\?([^?]*)\?=/gi,
    (_match, word: string) =>
      decodeQuotedPrintable(word.replace(/_/g, " ")).toString("utf8")
  );

  return decodeQuotedPrintable(withHeaders).toString("utf8");
}

let previous: Record<string, string | undefined>;

beforeAll(async () => {
  await startSink();

  previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    MAIL_FROM: process.env.MAIL_FROM,
    APP_URL: process.env.APP_URL,
  };

  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = "false";
  process.env.MAIL_FROM = "Ideas Flow <no-reply@ideas.test>";
  process.env.APP_URL = "https://flow.ideas.test";
});

afterAll(async () => {
  closeMailTransport();

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  received = [];
});

describe("handing a notice to a real mail server", () => {
  it("delivers it, addressed and readable", async () => {
    const document = await submitWithoutReceipt({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
      title: "Annual increment - Mr Bilal Khan",
    });

    const result = await emailService.dispatchPending();

    expect(result.sent).toBe(1);
    expect(received).toHaveLength(1);

    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { id: cast.reviewer.id },
    });
    const memo = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });

    // The envelope, as the server saw it.
    expect(received[0].from).toContain("no-reply@ideas.test");
    expect(received[0].to.join(" ")).toContain(reviewer.email);

    // And the message itself: a subject somebody can act on from a list, and
    // a body with the reference and a link that goes somewhere real.
    const message = readMessage(received[0].data);
    expect(message).toMatch(/^Subject: .*Approval needed/m);
    expect(message).toContain(memo.referenceNumber as string);
    expect(message).toContain(
      `https://flow.ideas.test/documents/${document.id}`
    );
    expect(message).toContain(`To: ${reviewer.email}`);
  });

  it("marks it sent, so the next sweep leaves it alone", async () => {
    await submitWithoutReceipt({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    await emailService.dispatchPending();
    const second = await emailService.dispatchPending();

    expect(second.sent).toBe(0);
    expect(received).toHaveLength(1);
    expect(
      (await prisma.emailMessage.findFirstOrThrow()).status
    ).toBe("SENT");
  });

  it("keeps the queue when the server is not listening, and delivers later", async () => {
    // The outage case, for real: the port is closed, the notice waits, and
    // the memo it belongs to is unaffected.
    const listening = port;
    process.env.SMTP_PORT = String(listening + 1);
    closeMailTransport();

    await submitWithoutReceipt({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    const duringOutage = await emailService.dispatchPending();
    expect(duringOutage.sent).toBe(0);
    expect(
      (await prisma.emailMessage.findFirstOrThrow()).status
    ).toBe("PENDING");

    process.env.SMTP_PORT = String(listening);
    closeMailTransport();

    expect((await emailService.dispatchPending()).sent).toBe(1);
    expect(received).toHaveLength(1);
  });
});


describe("proving the path works before a memo depends on it", () => {
  /** The person who presses the button: an administrator, since only they can. */
  let administrator: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    administrator = await makeUser({
      firstName: "Admin",
      departmentId: cast.department.id,
      loginRole: "ADMINISTRATOR",
    });
  });

  /**
   * The gap this closes.
   *
   * "Configured" only ever meant SMTP_HOST and MAIL_FROM were set. Whether the
   * host answers, whether the relay accepts this sender, whether anything
   * arrives - none of it was knowable until a real memo was assigned to a real
   * approver, and its failure mode is the worst one the product has: nobody is
   * told, and the memo simply sits.
   */
  it("sends a real message to the administrator who asked", async () => {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: administrator.id },
    });

    const result = await emailService.sendTestNotice(admin.id);

    expect(result.sentTo).toBe(admin.email);
    expect(received).toHaveLength(1);
    expect(received[0].to.join(" ")).toContain(admin.email);

    const message = readMessage(received[0].data);
    expect(message).toMatch(/^Subject: .*test notice/mi);
    // It has to be unmistakably not an approval request: an administrator who
    // forwards it, or an approver who is cc'd by accident, must not act on it.
    expect(message).toMatch(/Nothing has been approved/i);
  });

  it("never sends anywhere but the address on the account", async () => {
    /*
     * The whole reason there is no recipient in the request body. An endpoint
     * that mails chosen text to a chosen address is an open relay wearing a
     * company logo - and this one is reachable by anybody who has taken an
     * administrator's session.
     */
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: administrator.id },
    });
    const other = await prisma.user.findUniqueOrThrow({
      where: { id: cast.reviewer.id },
    });

    await emailService.sendTestNotice(admin.id);

    const everyRecipient = received.flatMap((message) => message.to).join(" ");
    expect(everyRecipient).toContain(admin.email);
    expect(everyRecipient).not.toContain(other.email);
  });

  it("shows the link real notices will carry, so a wrong one is caught here", async () => {
    // Mail can be configured perfectly and still be useless. Putting the URL
    // in the test message is what makes a forgotten APP_URL visible to the one
    // person who can fix it, at the moment they are looking.
    await emailService.sendTestNotice(administrator.id);

    expect(readMessage(received[0].data)).toContain("https://flow.ideas.test");
  });

  it("records it in the outbox, so somebody can see a test was run", async () => {
    const before = await prisma.emailMessage.count();

    await emailService.sendTestNotice(administrator.id);

    const rows = await prisma.emailMessage.findMany({
      orderBy: { createdAt: "desc" },
      take: 1,
    });

    expect(await prisma.emailMessage.count()).toBe(before + 1);
    expect(rows[0]).toMatchObject({ status: "SENT", documentId: null });
    expect(rows[0].sentAt).toBeInstanceOf(Date);
  });

  it("writes it to the audit trail like any other message that left", async () => {
    await emailService.sendTestNotice(administrator.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "EMAIL_SENT" },
      orderBy: { createdAt: "desc" },
    });

    expect(audit?.actorId).toBe(administrator.id);
    expect(audit?.entityType).toBe("EmailMessage");
  });

  it("hands back the server's own refusal rather than a shrug", async () => {
    /*
     * The point of sending it synchronously. An operator staring at a relay
     * that will not accept the sender needs the sentence the relay said, not
     * "queued - look again shortly", which is what the ordinary path would
     * give them.
     */
    const host = process.env.SMTP_HOST;
    // A port with nothing on it: the transport fails to connect.
    process.env.SMTP_PORT = "1";
    closeMailTransport();

    await expect(
      emailService.sendTestNotice(administrator.id)
    ).rejects.toThrow(/mail server refused it/i);

    process.env.SMTP_HOST = host;
    process.env.SMTP_PORT = String(port);
    closeMailTransport();
  });

  it("keeps the failure on the row, because nobody was told is a support question", async () => {
    process.env.SMTP_PORT = "1";
    closeMailTransport();

    await expect(
      emailService.sendTestNotice(administrator.id)
    ).rejects.toThrow();

    const row = await prisma.emailMessage.findFirst({
      orderBy: { createdAt: "desc" },
    });
    expect(row?.status).toBe("FAILED");
    expect(row?.lastError).toBeTruthy();

    process.env.SMTP_PORT = String(port);
    closeMailTransport();
  });

  it("says where to set one when there is no mail server at all", async () => {
    /*
     * Not a stack trace and not a silent success. This used to name the two
     * environment variables, which was the only answer there was; now there is
     * a screen, and the person reading this is on it - so it names the screen.
     * The variables still work and `lib/mailer` still mentions them, for the
     * deployment that never opens this page.
     */
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    closeMailTransport();

    await expect(
      emailService.sendTestNotice(administrator.id)
    ).rejects.toThrow(/Administration -> Mail/);

    expect(received).toHaveLength(0);

    process.env.SMTP_HOST = host;
    closeMailTransport();
  });
})

