import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCast, useCleanDatabase } from "../test/db";
import { encryptSecret } from "../lib/secretBox";
// `vi.mock` is hoisted above these, so what arrives here is the mock.
import { exchangeCode, verifyIdToken } from "../lib/entra";
import { prisma } from "../prisma";
import { ssoService } from "./sso.service";
import { ssoSettingsService } from "./ssoSettings.service";

/**
 * Signing in with a Microsoft work account, against a real database.
 *
 * Microsoft is stubbed, because none of what is worth testing here happens at
 * Microsoft. What is worth testing is everything this application does with
 * the answer: that a callback nothing started is refused, that neither half of
 * the round trip can be replayed, that a person Microsoft vouches for but this
 * system has never heard of does NOT get in, and that a sign-in produces
 * exactly one session.
 *
 * The last one is the reason `exchange` claims its row with a conditional
 * update rather than a read and a write: two tabs posting the same code would
 * both pass a read.
 */

vi.mock("../lib/entra", async () => {
  const actual = await vi.importActual<typeof import("../lib/entra")>(
    "../lib/entra"
  );

  return {
    ...actual,
    authorizeUrl: vi.fn().mockResolvedValue("https://login.microsoftonline.com/…"),
    exchangeCode: vi.fn().mockResolvedValue("an-id-token"),
    verifyIdToken: vi.fn(),
  };
});

const saysTheyAre = vi.mocked(verifyIdToken);
const trade = vi.mocked(exchangeCode);

useCleanDatabase();

/** `makeCast` has no exported type; every itest names it this way. */
let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  trade.mockClear();
  trade.mockResolvedValue("an-id-token");
  saysTheyAre.mockReset();
});

/** A configured, switched-on registration. */
async function configure() {
  await prisma.ssoSetting.create({
    data: {
      id: "singleton",
      enabled: true,
      tenantId: "11111111-2222-3333-4444-555555555555",
      clientId: "66666666-7777-8888-9999-000000000000",
      clientSecretCipher: encryptSecret("a-client-secret"),
      redirectUri: "https://flow.example.com/api/auth/sso/callback",
    },
  });
}

/** Microsoft says this is who came back. */
const arriveAs = (email: string) =>
  saysTheyAre.mockResolvedValue({ email, name: "A Person", objectId: "an-oid", authenticatedAt: null });

describe("confirming it is you with Microsoft", () => {
  /** Start a confirmation for this person, and have Microsoft answer. */
  async function confirmAs(person: { id: string; email: string }, authenticatedAt: Date | null) {
    await configure();
    await ssoService.startStepUp(person.id);
    const login = await prisma.ssoLogin.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    saysTheyAre.mockResolvedValue({
      email: person.email,
      name: "A Person",
      objectId: "an-oid",
      authenticatedAt,
    });
    return ssoService.callback({ code: "a-code", state: login.state });
  }

  it("counts a sign-in Microsoft says happened just now", async () => {
    await expect(confirmAs(cast.preparer, new Date())).resolves.toEqual(expect.any(String));
  });

  it("refuses one Microsoft says was a remembered, older sign-in", async () => {
    await expect(
      confirmAs(cast.preparer, new Date(Date.now() - 10 * 60_000))
    ).rejects.toMatchObject({ code: "SSO_NOT_FRESH" });
  });

  it("refuses one where Microsoft did not say when, rather than trusting it", async () => {
    // Let through before: the check only ran when the time was present, and
    // Microsoft leaves it out unless asked - so it almost never ran.
    await expect(confirmAs(cast.preparer, null)).rejects.toMatchObject({
      code: "SSO_NOT_FRESH",
    });
  });

  it("still lets an ordinary sign-in through without a time, which asks for no fresh password", async () => {
    await configure();
    await expect(signIn(cast.preparer.email)).resolves.toEqual(expect.any(String));
  });
});

/** Walk the browser through to the handover code. */
async function signIn(email: string) {
  await ssoService.start();
  const login = await prisma.ssoLogin.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  });
  arriveAs(email);

  return ssoService.callback({ code: "a-code", state: login.state });
}

describe("when it is not switched on", () => {
  it("refuses to start rather than redirecting somewhere", async () => {
    await expect(ssoService.start()).rejects.toThrow(/not switched on/i);
  });

  it("refuses a callback too, even one carrying a real-looking state", async () => {
    await expect(
      ssoService.callback({ code: "c", state: "s" })
    ).rejects.toThrow(/not switched on/i);
  });
});

describe("starting", () => {
  beforeEach(configure);

  it("writes down what the callback will have to prove", async () => {
    await ssoService.start();

    const login = await prisma.ssoLogin.findFirstOrThrow();

    expect(login.state).not.toBe("");
    expect(login.nonce).not.toBe("");
    expect(login.codeVerifier).not.toBe("");
    // Nobody is signed in yet, and no way in exists yet.
    expect(login.userId).toBeNull();
    expect(login.codeHash).toBeNull();
  });

  it("gives every sign-in its own state", async () => {
    await ssoService.start();
    await ssoService.start();

    const rows = await prisma.ssoLogin.findMany();

    expect(new Set(rows.map((row) => row.state)).size).toBe(2);
  });
});

describe("the callback", () => {
  beforeEach(configure);

  it("refuses a state nothing here ever issued", async () => {
    // The whole job of `state`: this is a public endpoint, and without it
    // anyone could drive a sign-in that no browser started.
    await expect(
      ssoService.callback({ code: "a-code", state: "never-issued" })
    ).rejects.toThrow(/could not be completed/i);

    expect(trade).not.toHaveBeenCalled();
  });

  it("refuses a state that has already been through", async () => {
    await ssoService.start();
    const login = await prisma.ssoLogin.findFirstOrThrow();
    arriveAs(cast.preparer.email);

    await ssoService.callback({ code: "a-code", state: login.state });

    await expect(
      ssoService.callback({ code: "a-code", state: login.state })
    ).rejects.toThrow(/could not be completed/i);
  });

  it("refuses one that sat too long", async () => {
    await ssoService.start();
    const login = await prisma.ssoLogin.findFirstOrThrow();
    await prisma.ssoLogin.update({
      where: { id: login.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      ssoService.callback({ code: "a-code", state: login.state })
    ).rejects.toThrow(/could not be completed/i);
  });

  it("does not let a stranger in on Microsoft's say-so", async () => {
    /*
     * The refusal that matters most. Holding a mailbox in the directory is
     * not the same as being a person in an approval chain, and a system that
     * enrolled every new starter automatically would quietly put strangers in
     * a list of approvers.
     */
    await ssoService.start();
    const login = await prisma.ssoLogin.findFirstOrThrow();
    arriveAs("someone.else@ideas.com.pk");

    await expect(
      ssoService.callback({ code: "a-code", state: login.state })
    ).rejects.toThrow(/not set up in IdeasFlow/i);

    expect(await prisma.refreshSession.count()).toBe(0);
  });

  it("refuses an account that has been switched off", async () => {
    /*
     * A separate door, and it has to be shut separately. Switching an account
     * off stops the password sign-in; the directory still holds the mailbox,
     * so single sign-on would walk straight past the lock that was just
     * turned. Named to the person, for the same reason the refusal above is:
     * they have proved who they are to Microsoft, so there is nothing left to
     * withhold.
     */
    await prisma.user.update({
      where: { id: cast.preparer.id },
      data: { deactivatedAt: new Date() },
    });

    await ssoService.start();
    const login = await prisma.ssoLogin.findFirstOrThrow();
    arriveAs(cast.preparer.email);

    await expect(
      ssoService.callback({ code: "a-code", state: login.state })
    ).rejects.toThrow(/switched off/i);

    // And no handover code issued against it, so nothing can be redeemed.
    expect(await prisma.refreshSession.count()).toBe(0);
  });

  it("lets in an account that has never been given a password", async () => {
    /*
     * Deliberate, and the case single sign-on exists for. The directory is
     * the credential; refusing somebody because they have no local password
     * would refuse exactly the people being onboarded this way.
     */
    await prisma.user.update({
      where: { id: cast.preparer.id },
      data: { passwordHash: null },
    });

    await expect(signIn(cast.preparer.email)).resolves.toEqual(
      expect.any(String)
    );
  });

  // Address casing is settled one layer down, in `verifyIdToken`, which is
  // where the claim is read and lower-cased. Asserting it here would only
  // prove the stub returns what it was handed - see `entraIdToken.test.ts`.

  it("throws the verifier away once it has been spent", async () => {
    const handover = await signIn(cast.preparer.email);
    const login = await prisma.ssoLogin.findFirstOrThrow();

    expect(login.codeVerifier).toBe("");
    expect(login.userId).toBe(cast.preparer.id);
    // The code itself is never stored, only its digest.
    expect(login.codeHash).toBe(
      createHash("sha256").update(handover).digest("hex")
    );
  });
});

describe("collecting the session", () => {
  beforeEach(configure);

  it("answers in the same shape a password sign-in does", async () => {
    const handover = await signIn(cast.preparer.email);

    const result = await ssoService.exchange(handover);

    expect(result).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { id: cast.preparer.id, email: cast.preparer.email },
    });
  });

  it("issues exactly one session, however many tabs ask", async () => {
    // The reason the row is claimed with a conditional update rather than a
    // read and then a write: two tabs would both pass a read.
    const handover = await signIn(cast.preparer.email);

    const results = await Promise.allSettled([
      ssoService.exchange(handover),
      ssoService.exchange(handover),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.refreshSession.count()).toBe(1);
  });

  it("refuses a code that has already been spent", async () => {
    const handover = await signIn(cast.preparer.email);
    await ssoService.exchange(handover);

    await expect(ssoService.exchange(handover)).rejects.toThrow(
      /already been used or has expired/i
    );
  });

  it("refuses one nobody was ever given", async () => {
    await expect(ssoService.exchange("not-a-real-code")).rejects.toThrow(
      /already been used or has expired/i
    );
  });

  it("refuses one that went stale between the redirect and the post", async () => {
    const handover = await signIn(cast.preparer.email);
    await prisma.ssoLogin.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(ssoService.exchange(handover)).rejects.toThrow(
      /already been used or has expired/i
    );
  });

  it("refuses a half-finished sign-in that never reached the callback", async () => {
    // A row exists, but nothing has established who it belongs to.
    await ssoService.start();
    const login = await prisma.ssoLogin.findFirstOrThrow();

    await expect(ssoService.exchange(login.state)).rejects.toThrow(
      /already been used or has expired/i
    );
  });
});

describe("the registration itself", () => {
  it("will not be switched on while something it needs is missing", async () => {
    await expect(
      ssoSettingsService.save(
        { enabled: true, tenantId: "a-tenant" },
        cast.preparer.id
      )
    ).rejects.toThrow(/needs the directory ID/i);
  });

  it("keeps the stored secret when the field is left blank", async () => {
    await configure();

    await ssoSettingsService.save(
      {
        enabled: true,
        redirectUri: "https://flow.example.com/api/auth/sso/callback",
      },
      cast.preparer.id
    );

    // Correcting a redirect URI must not require knowing the secret - that is
    // the situation this screen exists to get somebody out of.
    const row = await prisma.ssoSetting.findFirstOrThrow();
    expect(row.clientSecretCipher).not.toBeNull();
    expect(row.tenantId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("never reports the secret back, only that there is one", async () => {
    await configure();

    const view = await ssoSettingsService.get();

    expect(view).toMatchObject({ hasClientSecret: true, configured: true });
    expect(JSON.stringify(view)).not.toContain("a-client-secret");
    // The ids are not secrets, but together they name a target and this
    // screen ends up in screenshots.
    expect(view.tenantIdTail).toMatch(/^…/);
  });

  it("stops sign-in the moment it is cleared", async () => {
    await configure();
    await ssoSettingsService.clear(cast.preparer.id);

    await expect(ssoService.start()).rejects.toThrow(/not switched on/i);
    expect(await prisma.ssoSetting.count()).toBe(0);
  });
});
