/**
 * Whose letterhead a generated memo carries.
 *
 * One row, read on each render and cached for a few seconds - a memo is not
 * submitted often enough for this to matter, and an administrator who changes
 * the organisation name should not have to restart anything to see it.
 *
 * With no row at all the packaged asset and the delivered name are used, so a
 * fresh install renders a correct memo before anybody has visited a settings
 * screen. That is the point of a default: the feature works, and configuring
 * it is an improvement rather than a prerequisite.
 */
import { readDefaultLogo } from "../lib/memoTemplate/assets";
import { logger } from "../lib/logger";
import { storageService } from "../lib/storage";
import { prisma } from "../prisma";
import type { MemoBranding } from "../lib/memoTemplate";

export const BRANDING_SETTING_ID = "singleton";

/** Used until a branding row says otherwise. */
export const DEFAULT_ORGANISATION_NAME = "Ideas Pvt Ltd";

const CACHE_MS = 10_000;

let cached: { at: number; value: MemoBranding } | null = null;

export const brandingService = {
  /** Drops the cache. For tests, and for a settings screen that has saved. */
  forget(): void {
    cached = null;
  },

  async getBranding(): Promise<MemoBranding> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

    const row = await prisma.brandingSetting.findUnique({
      where: { id: BRANDING_SETTING_ID },
      select: { organisationName: true, logoStoragePath: true },
    });

    let logo: Buffer | null = null;

    if (row?.logoStoragePath) {
      try {
        logo = await storageService.downloadDocument(row.logoStoragePath);
      } catch (error) {
        /*
         * A missing uploaded logo falls back to the packaged one rather than
         * failing the submission. The memo is the point; the letterhead is
         * not worth refusing one over, and an operator who moved the storage
         * directory would otherwise find that nobody could submit anything.
         */
        logger.warn("branding.logo_unreadable", {
          path: row.logoStoragePath,
          note: "Falling back to the packaged letterhead.",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const value: MemoBranding = {
      organisationName: row?.organisationName ?? DEFAULT_ORGANISATION_NAME,
      logo: logo ?? readDefaultLogo(),
    };

    cached = { at: Date.now(), value };
    return value;
  },
};
