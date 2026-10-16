/**
 * The paper a generated memo is drawn on, organisation-wide.
 *
 * Kept in the same singleton row as the organisation's name and letterhead,
 * because it answers the same question - how a memo looks - and because a
 * second settings table for five numbers earns nothing.
 *
 * Cached for the same few seconds and for the same reason: it is read on every
 * render, and an administrator who changes it should see the change without
 * restarting anything.
 *
 * With no row, or with any column left null, the delivered default is used.
 * That is what makes this additive: a deployment that never opens the settings
 * screen draws byte-identical documents to the ones it drew before.
 */
import {
  DEFAULT_PAGE_SETUP,
  isDefaultSetup,
  isPaperName,
  type PageSetup,
} from "../lib/memoTemplate/geometry";
import { prisma } from "../prisma";
import { BRANDING_SETTING_ID } from "./branding.service";

const CACHE_MS = 10_000;

/**
 * The entity id this setting is audited against.
 *
 * `audit_logs.entity_id` is a uuid column, and "singleton" is not one - so a
 * settings row that has no id of its own is given a fixed sentinel, the same
 * way mail (0001), workflow (0002) and SSO (0003) already are. Constant, so
 * every change to the page lands on one timeline somebody can read.
 */
export const PAGE_SETUP_AUDIT_ID = "00000000-0000-4000-8000-000000000004";

let cached: { at: number; value: PageSetup } | null = null;

/** A stored column, or the default for that edge. */
function edge(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const pageSetupService = {
  /** Drops the cache. For tests, and for a settings screen that has saved. */
  forget(): void {
    cached = null;
  },

  async getPageSetup(): Promise<PageSetup> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

    const row = await prisma.brandingSetting.findUnique({
      where: { id: BRANDING_SETTING_ID },
      select: {
        pagePaper: true,
        pageMarginLeft: true,
        pageMarginRight: true,
        pageMarginTop: true,
        pageMarginBottom: true,
      },
    });

    const value: PageSetup = {
      paper: isPaperName(row?.pagePaper) ? row.pagePaper : DEFAULT_PAGE_SETUP.paper,
      marginLeft: edge(row?.pageMarginLeft, DEFAULT_PAGE_SETUP.marginLeft),
      marginRight: edge(row?.pageMarginRight, DEFAULT_PAGE_SETUP.marginRight),
      marginTop: edge(row?.pageMarginTop, DEFAULT_PAGE_SETUP.marginTop),
      marginBottom: edge(row?.pageMarginBottom, DEFAULT_PAGE_SETUP.marginBottom),
    };

    cached = { at: Date.now(), value };
    return value;
  },

  /**
   * What to record on a version being filed.
   *
   * Null when the page is the delivered default, so the column stays empty on
   * every deployment that never changes it - and a null then reads
   * unambiguously as "drawn the way it has always been drawn" rather than as
   * a value somebody forgot to write.
   */
  async setupToRecord(): Promise<PageSetup | null> {
    const setup = await this.getPageSetup();
    return isDefaultSetup(setup) ? null : setup;
  },

  async update(
    setup: PageSetup,
    updatedById: string,
    organisationNameIfCreating: string
  ): Promise<PageSetup> {
    /*
     * Upsert, because the row may not exist: a deployment can reach a page
     * setup screen without ever having set an organisation name, and refusing
     * to save until they do would be an order nobody asked for.
     */
    await prisma.brandingSetting.upsert({
      where: { id: BRANDING_SETTING_ID },
      create: {
        id: BRANDING_SETTING_ID,
        organisationName: organisationNameIfCreating,
        pagePaper: setup.paper,
        pageMarginLeft: setup.marginLeft,
        pageMarginRight: setup.marginRight,
        pageMarginTop: setup.marginTop,
        pageMarginBottom: setup.marginBottom,
        updatedById,
      },
      update: {
        pagePaper: setup.paper,
        pageMarginLeft: setup.marginLeft,
        pageMarginRight: setup.marginRight,
        pageMarginTop: setup.marginTop,
        pageMarginBottom: setup.marginBottom,
        updatedById,
      },
    });

    this.forget();
    return this.getPageSetup();
  },
};
