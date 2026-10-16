import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, useCleanDatabase } from "../test/db";
import { hashPassword } from "../lib/password";
import { encryptSecret } from "../lib/secretBox";
import { base32Decode, hotp, stepAt } from "../lib/totp";
import { prisma } from "../prisma";
import { authService } from "./auth.service";
import { totpService } from "./totp.service";

/**
 * The second factor, against a real database.
 *
 * Almost all of this is about the ways a second factor is worse than none.
 * A code that can be replayed inside its ninety-second window protects
 * nobody; an attempt counter that a hung request can dodge turns a
 * million-wide space into an afternoon's work; a factor an administrator
 * cannot lift strands somebody outside their own approvals for good. Each of
 * those has a test here, and each was written by breaking the implementation
 * first to watch it fail.
 *
 * The codes are computed the way a phone computes them - HMAC over the step
 * number - rather than by calling the verifier, so these tests would notice
 * the day the two stopped agreeing.
 */

useCleanDatabase();

let user: Awaited<ReturnType<typeof makeUser>>;

/** The secret this account is enrolled with, in the clear. */
let secret: string;

const PASSWORD = "a-real-password";

/** What the phone would show, for the step containing `atMs`. */
function phoneShows(atMs = Date.now()): string {
  return hotp(base32Decode(secret)!, BigInt(stepAt(atMs)));
}

/**
 * Enrolled and switched on, which is where most of these start.
 *
 * The spent step is cleared afterwards, and that is not papering over
 * anything - it is standing in for the half a minute that passes between
 * somebody finishing enrolment and next signing in. Without it every test
 * below would be trying to reuse the very code that switched the factor on,
 * which the replay rule refuses and which `activate spends its own code`
 * asserts on purpose.
 */
async function enrolled() {
  const started = await totpService.beginEnrolment(user.id);
  secret = started.secret;

  const { recoveryCodes } = await totpService.activate(user.id, phoneShows());

  await prisma.user.update({
    where: { id: user.id },
    data: { totpLastStep: null },
  });

  return recoveryCodes;
}

beforeEach(async () => {
  user = await makeUser({ firstName: "Twostep" });

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  });
});

describe("enrolling", () => {
  it("does not switch the factor on until a code comes back", async () => {
    /*
     * The whole reason enrolment is two steps. A secret written down proves a
     * QR code was drawn, not that anybody's phone can read it - and switching
     * the factor on at that point is exactly how somebody locks themselves
     * out of their own account during setup.
     */
    await totpService.beginEnrolment(user.id);

    const midway = await totpService.status(user.id);
    expect(midway.enabled).toBe(false);
    expect(midway.pending).toBe(true);

    // And the sign-in still goes straight through.
    const signIn = await authService.login({
      email: user.email,
      password: PASSWORD,
    });
    expect(signIn).toHaveProperty("accessToken");
  });

  it("switches it on once one does, and hands over ten recovery codes", async () => {
    const codes = await enrolled();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect((await totpService.status(user.id)).enabled).toBe(true);
  });

  it("refuses a code from the wrong secret", async () => {
    await totpService.beginEnrolment(user.id);

    await expect(totpService.activate(user.id, "000000")).rejects.toThrow(
      /not accepted/i
    );
    expect((await totpService.status(user.id)).enabled).toBe(false);
  });

  it("gives a second scan a matching secret, not a stale one", async () => {
    /*
     * Somebody who closes the screen and starts again. Keeping the first
     * secret would be the version where the phone holds one and the server
     * holds another, and the only symptom is a correct code being refused
     * with nothing on screen to explain it.
     */
    const first = await totpService.beginEnrolment(user.id);
    const second = await totpService.beginEnrolment(user.id);

    expect(second.secret).not.toBe(first.secret);

    secret = second.secret;
    await expect(
      totpService.activate(user.id, phoneShows())
    ).resolves.toMatchObject({ recoveryCodes: expect.any(Array) });
  });

  it("stores the secret unreadable", async () => {
    const started = await totpService.beginEnrolment(user.id);
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true },
    });

    // The table must not hold a working authenticator for every account in
    // the organisation in a form a database backup hands straight over.
    expect(row?.totpSecret).not.toContain(started.secret);
    expect(row?.totpSecret).toMatch(/^gcm1\./);
  });

  it("spends the code that switched it on", async () => {
    /*
     * The confirmation code is a real code and gets used up like one.
     * Otherwise the six digits somebody typed into a setup screen - over a
     * shoulder, in an open-plan office, on a shared machine - stay good at
     * the sign-in screen for the rest of their window.
     */
    const started = await totpService.beginEnrolment(user.id);
    secret = started.secret;

    const code = phoneShows();
    await totpService.activate(user.id, code);

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code })
    ).rejects.toThrow(/not accepted/i);
  });

  it("will not start again over a factor that is already on", async () => {
    await enrolled();

    await expect(totpService.beginEnrolment(user.id)).rejects.toThrow(
      /already switched on/i
    );
  });
});

describe("signing in", () => {
  it("stops at a challenge instead of issuing a session", async () => {
    await enrolled();

    const result = await authService.login({
      email: user.email,
      password: PASSWORD,
    });

    expect(result).toMatchObject({ twoFactorRequired: true });
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");

    // And no session was quietly created on the way past.
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(0);
  });

  it("says nothing about who the account is", async () => {
    // Somebody who guessed a password correctly learns that the account has a
    // second factor. They must not also learn the name, the role, or anything
    // else they could use elsewhere.
    await enrolled();

    const result = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual([
      "challenge",
      "expiresAt",
      "twoFactorRequired",
    ]);
  });

  it("finishes with the code, in the shape every other sign-in answers with", async () => {
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    const session = await totpService.completeChallenge({
      challenge,
      code: phoneShows(),
    });

    expect(session).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { id: user.id, email: user.email, role: "USER" },
    });
  });

  it("refuses a challenge nothing here issued", async () => {
    await enrolled();

    await expect(
      totpService.completeChallenge({
        challenge: "a".repeat(43),
        code: phoneShows(),
      })
    ).rejects.toThrow(/expired/i);
  });

  it("holds the challenge hashed, so the table is no way in", async () => {
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    const row = await prisma.totpChallenge.findFirst({
      where: { userId: user.id },
      select: { codeHash: true },
    });

    expect(row?.codeHash).toBe(
      createHash("sha256").update(challenge).digest("hex")
    );
    expect(row?.codeHash).not.toBe(challenge);
  });

  it("will not accept an expired challenge", async () => {
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await prisma.totpChallenge.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      totpService.completeChallenge({ challenge, code: phoneShows() })
    ).rejects.toThrow(/expired/i);
  });
});

describe("a code that has already been used", () => {
  it("is refused the second time, inside its own window", async () => {
    /*
     * The defect a naive implementation ships with. A correct code stays
     * correct for up to ninety seconds, so one read over a shoulder - or typed
     * into a page pretending to be the sign-in screen - is replayable for the
     * rest of that window unless the step it came from is refused afterwards.
     */
    await enrolled();

    const code = phoneShows();

    const first = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };
    await totpService.completeChallenge({ challenge: first.challenge, code });

    const second = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge: second.challenge, code })
    ).rejects.toThrow(/not accepted/i);
  });

  it("takes the previous step down with it", async () => {
    // A phone one step slow, replayed after a newer code went through.
    await enrolled();

    const now = Date.now();
    const previous = hotp(base32Decode(secret)!, BigInt(stepAt(now) - 1));

    const first = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };
    await totpService.completeChallenge({
      challenge: first.challenge,
      code: phoneShows(now),
    });

    const second = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge: second.challenge, code: previous })
    ).rejects.toThrow(/not accepted/i);
  });

  it("does not spend the challenge when the code is refused", async () => {
    // Mistyping a digit must not cost the whole sign-in. Four more tries.
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: "000000" })
    ).rejects.toThrow(/not accepted/i);

    await expect(
      totpService.completeChallenge({ challenge, code: phoneShows() })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });
});

describe("guessing at six digits", () => {
  it("gives up after five tries and will not take a correct code afterwards", async () => {
    /*
     * The real bound. Six digits is a space of one million, which sounds ample
     * and is minutes at a thousand guesses a second - so the cost of guessing
     * has to be a fresh, password-verified sign-in for every five tries, not
     * an unlimited run at one challenge.
     */
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        totpService.completeChallenge({ challenge, code: "000000" })
      ).rejects.toThrow();
    }

    await expect(
      totpService.completeChallenge({ challenge, code: phoneShows() })
    ).rejects.toThrow(/expired/i);
  });

  it("counts the guess before checking it", async () => {
    // "Increment afterwards" is the version where a client that hangs up
    // mid-request guesses for free.
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: "000000" })
    ).rejects.toThrow();

    const row = await prisma.totpChallenge.findFirst({
      where: { userId: user.id },
      select: { attempts: true },
    });

    expect(row?.attempts).toBe(1);
  });

  it("says how many tries are left", async () => {
    await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: "000000" })
    ).rejects.toThrow(/4 tries left/);
  });
});

describe("recovery codes", () => {
  it("let somebody in when the phone is gone", async () => {
    const codes = await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: codes[0] })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it("work with the dashes stripped, or typed in lower case", async () => {
    // People transcribe these off paper. A set that only works pasted exactly
    // as shown is a set that does not work at four in the afternoon.
    const codes = await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({
        challenge,
        code: codes[0].replace(/-/g, "").toLowerCase(),
      })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it("are single use", async () => {
    const codes = await enrolled();

    const first = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };
    await totpService.completeChallenge({
      challenge: first.challenge,
      code: codes[0],
    });

    const second = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge: second.challenge, code: codes[0] })
    ).rejects.toThrow(/not accepted/i);
  });

  it("do not let one person's code work on another person's account", async () => {
    const mine = await enrolled();

    const other = await makeUser({ firstName: "Other" });
    await prisma.user.update({
      where: { id: other.id },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });

    const started = await totpService.beginEnrolment(other.id);
    const theirSecret = secret;
    secret = started.secret;
    await totpService.activate(other.id, phoneShows());
    secret = theirSecret;

    const { challenge } = (await authService.login({
      email: other.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: mine[0] })
    ).rejects.toThrow(/not accepted/i);
  });

  it("are stored hashed, and counted down as they are spent", async () => {
    const codes = await enrolled();

    const stored = await prisma.totpRecoveryCode.findMany({
      where: { userId: user.id },
      select: { codeHash: true },
    });
    expect(stored.map((row) => row.codeHash)).not.toContain(codes[0]);

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };
    await totpService.completeChallenge({ challenge, code: codes[0] });

    const status = await totpService.status(user.id);
    expect(status.recoveryCodesRemaining).toBe(9);
    expect(status.recoveryCodesUsed).toBe(1);
  });

  it("leave a trail when one is used, because that is the unusual event", async () => {
    const codes = await enrolled();

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };
    await totpService.completeChallenge({ challenge, code: codes[0] });

    const logged = await prisma.auditLog.findFirst({
      where: { actorId: user.id, action: "TWO_FACTOR_RECOVERY_USED" },
    });

    expect(logged).not.toBeNull();
  });

  it("are replaced as a whole set, never topped up", async () => {
    // A set half of which is from the paper somebody lost is not a set
    // anybody can reason about.
    const old = await enrolled();

    const { recoveryCodes } = await totpService.replaceRecoveryCodes(
      user.id,
      phoneShows()
    );

    expect(recoveryCodes).toHaveLength(10);
    expect(await prisma.totpRecoveryCode.count({ where: { userId: user.id } })).toBe(10);

    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: old[0] })
    ).rejects.toThrow(/not accepted/i);
  });
});

describe("turning it off", () => {
  it("needs the password, not a code", async () => {
    // The threat is an unlocked laptop. A phone in a pocket across the room
    // is no obstacle to whoever sat down at it.
    await enrolled();

    await expect(totpService.disable(user.id, "not-the-password")).rejects.toThrow(
      /not correct/i
    );
    expect((await totpService.status(user.id)).enabled).toBe(true);
  });

  it("clears the secret and the recovery codes together", async () => {
    await enrolled();

    await totpService.disable(user.id, PASSWORD);

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true, totpActivatedAt: true, totpLastStep: true },
    });

    expect(row).toMatchObject({
      totpSecret: null,
      totpActivatedAt: null,
      totpLastStep: null,
    });
    expect(await prisma.totpRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
  });

  it("lets the password alone sign in again afterwards", async () => {
    await enrolled();
    await totpService.disable(user.id, PASSWORD);

    await expect(
      authService.login({ email: user.email, password: PASSWORD })
    ).resolves.toHaveProperty("accessToken");
  });
});

describe("an administrator lifting it", () => {
  it("is the way back for somebody who lost the phone and the codes", async () => {
    /*
     * The other half of being willing to ship this at all. A product that can
     * strand somebody outside their own approvals with no way back is worse
     * than one with no second factor.
     */
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });
    await enrolled();

    await totpService.resetFor(user.id, admin.id);

    await expect(
      authService.login({ email: user.email, password: PASSWORD })
    ).resolves.toHaveProperty("accessToken");
  });

  it("is loud in the trail, because it is also what a stolen session would do", async () => {
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });
    await enrolled();

    await totpService.resetFor(user.id, admin.id);

    const logged = await prisma.auditLog.findFirst({
      where: { action: "TWO_FACTOR_RESET" },
      select: { actorId: true, entityId: true },
    });

    // Who did it and to whom, which is the pair that makes the row worth
    // anything when somebody reads it back.
    expect(logged).toMatchObject({ actorId: admin.id, entityId: user.id });
  });

  it("refuses on an account that never had it on, rather than saying nothing", async () => {
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });

    await expect(totpService.resetFor(user.id, admin.id)).rejects.toThrow(
      /not switched on/i
    );
  });
});

/**
 * A stored secret whose GCM tag belongs to a different encryption, so it can
 * never be read back. `gcm1.<iv>.<tag>.<ciphertext>` - the tag is swapped and
 * everything else is left alone.
 */
function withAnotherTag(stored: string): string {
  const mine = stored.split(".");
  const other = encryptSecret("a-different-secret").split(".");

  return [mine[0], mine[1], other[2], mine[3]].join(".");
}

describe("a secret that will not decrypt", () => {
  /*
   * What a rotated JWT_SECRET leaves behind: a person with a working phone and
   * a code that will never be accepted again. Their own screen has to say so;
   * the sign-in screen must not, because it would be telling an attacker the
   * same thing.
   */
  let codes: string[];

  beforeEach(async () => {
    codes = await enrolled();

    // What a rotated key leaves: a stored value the GCM tag check refuses.
    await prisma.user.update({
      where: { id: user.id },
      /*
       * Corrupted by giving one encryption another's authentication tag.
       *
       * The obvious way - change the last character of the stored value -
       * does not reliably corrupt anything, and cost two runs nobody could
       * reproduce before that was understood. Base64url packs 6 bits per
       * character, so when a segment's length mod 4 is 1 or 2 the final
       * character's low bits fall off the end of the last byte and are
       * discarded: `AAAAx` and `AAAAy` decode to exactly the same bytes.
       * Whether the trick worked depended on the length of the ciphertext,
       * which depends on the secret, which is random.
       *
       * A tag from a different encryption cannot validate this ciphertext,
       * whatever the lengths are. That is what a rotated `JWT_SECRET` leaves
       * behind, and it is what this block is about.
       */
      data: { totpSecret: withAnotherTag(encryptSecret("a-secret")) },
    });
  });

  it("is reported on the account screen as its own state", async () => {
    const status = await totpService.status(user.id);

    expect(status.enabled).toBe(true);
    expect(status.secretUnreadable).toBe(true);
  });

  it("refuses at sign-in without explaining why", async () => {
    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: phoneShows() })
    ).rejects.toThrow(/not accepted/i);
  });

  it("still lets a recovery code through", async () => {
    /*
     * The codes are hashed rather than encrypted, so they survive the rotation
     * that took the secret out. That makes them the way back in without an
     * administrator, and it is the strongest argument for handing them over at
     * enrolment rather than offering them later on request.
     */
    const { challenge } = (await authService.login({
      email: user.email,
      password: PASSWORD,
    })) as { challenge: string };

    await expect(
      totpService.completeChallenge({ challenge, code: codes[0] })
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it("tells somebody asking for new recovery codes what is actually wrong", async () => {
    // Not "that code was not accepted", which is what they would conclude
    // from a generic refusal while typing the correct one off their phone.
    await expect(
      totpService.replaceRecoveryCodes(user.id, phoneShows())
    ).rejects.toThrow(/cannot be read on this server/i);
  });
});
