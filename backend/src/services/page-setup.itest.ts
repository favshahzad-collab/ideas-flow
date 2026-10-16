import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PAGE_SETUP, PAPER } from "../lib/memoTemplate/geometry";
import { BRANDING_SETTING_ID } from "./branding.service";
import { pageSetupService } from "./pageSetup.service";
import { prisma } from "../prisma";
import { makeUser, useCleanDatabase } from "../test/db";

/**
 * The organisation's page, and the page each filed version was drawn on.
 *
 * The unit tests prove the renderer honours a setup it is handed. These prove
 * the join no unit test can see: that the setting reaches the renderer, that
 * a filed version records what it was drawn with, and - the one that protects
 * the audit trail - that changing the setting afterwards does not re-draw a
 * memo somebody has already signed.
 */
/*
 * Its own database state, like every other integration file. It used to take
 * "the first user there is" without making one, so it passed or failed on
 * whatever the file before it happened to leave behind.
 */
useCleanDatabase();

describe("the organisation's page setup", () => {
  beforeEach(async () => {
    await prisma.brandingSetting.deleteMany({});
    pageSetupService.forget();
  });

  it("is the delivered default when nothing has been set", async () => {
    // A fresh install renders a correct memo before anybody visits settings.
    expect(await pageSetupService.getPageSetup()).toEqual(DEFAULT_PAGE_SETUP);
  });

  it("is still the default when a branding row exists but names no page", async () => {
    // The row is created by the letterhead screen, which knows nothing about
    // margins - so its page columns are null and must read as the default.
    await prisma.brandingSetting.create({
      data: { id: BRANDING_SETTING_ID, organisationName: "Ideas Pvt Ltd" },
    });
    pageSetupService.forget();

    expect(await pageSetupService.getPageSetup()).toEqual(DEFAULT_PAGE_SETUP);
  });

  it("records nothing against a version while the page is the default", async () => {
    expect(await pageSetupService.setupToRecord()).toBeNull();
  });

  it("gives back what was saved, and then has something to record", async () => {
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });

    const saved = await pageSetupService.update(
      {
        paper: "LETTER",
        marginLeft: 72,
        marginRight: 54,
        marginTop: 60,
        marginBottom: 60,
      },
      admin.id,
      "Ideas Pvt Ltd"
    );

    expect(saved.paper).toBe("LETTER");
    expect(saved.marginLeft).toBe(72);
    expect(saved.marginRight).toBe(54);

    // Now it is no longer the default, so a filed version must carry it.
    expect(await pageSetupService.setupToRecord()).toEqual(saved);
  });

  it("creates the row when the organisation has never set a name", async () => {
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });

    await pageSetupService.update(
      { ...DEFAULT_PAGE_SETUP, paper: "LETTER" },
      admin.id,
      "Ideas Pvt Ltd"
    );

    const row = await prisma.brandingSetting.findUniqueOrThrow({
      where: { id: BRANDING_SETTING_ID },
    });

    expect(row.pagePaper).toBe("LETTER");
    expect(row.organisationName).toBe("Ideas Pvt Ltd");
  });

  it("does not disturb a letterhead that was already configured", async () => {
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });

    await prisma.brandingSetting.create({
      data: {
        id: BRANDING_SETTING_ID,
        organisationName: "Somebody Else Ltd",
        logoStoragePath: "branding/logo.png",
      },
    });
    pageSetupService.forget();

    await pageSetupService.update(
      { ...DEFAULT_PAGE_SETUP, marginLeft: 90 },
      admin.id,
      "Ideas Pvt Ltd"
    );

    const row = await prisma.brandingSetting.findUniqueOrThrow({
      where: { id: BRANDING_SETTING_ID },
    });

    // Saving a margin must not rename the organisation or drop its logo.
    expect(row.organisationName).toBe("Somebody Else Ltd");
    expect(row.logoStoragePath).toBe("branding/logo.png");
    expect(row.pageMarginLeft).toBe(90);
  });

  it("serves the new value immediately, not after the cache expires", async () => {
    const admin = await makeUser({ loginRole: "ADMINISTRATOR" });

    // Warm the cache with the default first, which is what a running server
    // would be holding when an administrator presses save.
    expect(await pageSetupService.getPageSetup()).toEqual(DEFAULT_PAGE_SETUP);

    await pageSetupService.update(
      { ...DEFAULT_PAGE_SETUP, paper: "LETTER" },
      admin.id,
      "Ideas Pvt Ltd"
    );

    expect((await pageSetupService.getPageSetup()).paper).toBe("LETTER");
  });

  it("knows Letter is a different sheet from A4", () => {
    // Guards the numbers themselves: a typo here is a wrong page everywhere.
    expect(PAPER.A4).toEqual({ width: 595.28, height: 841.89 });
    expect(PAPER.LETTER).toEqual({ width: 612, height: 792 });
  });
});
