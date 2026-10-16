import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEOMETRY,
  DEFAULT_PAGE_SETUP,
  MAX_MARGIN,
  MIN_MARGIN,
  PAPER,
  isDefaultSetup,
  resolveGeometry,
  type PageSetup,
} from "./geometry";
import { renderMemo } from "./renderMemo";
import { drawnTextOnPage } from "../../test/pdfText";
import { FUEL_REQUEST } from "./fuelRequest.fixture";

/**
 * The page, now that it is a value rather than four constants.
 *
 * The test that matters most is the last one: a deployment that never opens
 * the new setting must get the document it got before, byte for byte. Four
 * memos are already filed against checksums drawn with the old constants, and
 * a renderer that shifts anything by a point makes those checksums wrong.
 */
describe("resolving a page setup", () => {
  it("gives back exactly the old constants by default", () => {
    expect(DEFAULT_GEOMETRY).toMatchObject({
      paper: "A4",
      width: 595.28,
      height: 841.89,
      marginLeft: 43.2,
      marginRight: 43.2,
      marginTop: 57.6,
      marginBottom: 57.6,
    });

    // The two derived values the rest of the renderer measures against.
    expect(DEFAULT_GEOMETRY.textWidth).toBeCloseTo(508.88, 2);
    expect(DEFAULT_GEOMETRY.textHeight).toBeCloseTo(726.69, 2);
  });

  it("treats a missing setup and an explicit default as the same page", () => {
    expect(resolveGeometry()).toEqual(DEFAULT_GEOMETRY);
    expect(resolveGeometry(null)).toEqual(DEFAULT_GEOMETRY);
    expect(resolveGeometry(DEFAULT_PAGE_SETUP)).toEqual(DEFAULT_GEOMETRY);
  });

  it("measures Letter from Letter, not from A4", () => {
    const letter = resolveGeometry({ ...DEFAULT_PAGE_SETUP, paper: "LETTER" });

    expect(letter.width).toBe(PAPER.LETTER.width);
    expect(letter.height).toBe(PAPER.LETTER.height);
    // Wider sheet, same margins, so a wider column - and a shorter page.
    expect(letter.textWidth).toBeGreaterThan(DEFAULT_GEOMETRY.textWidth);
    expect(letter.textHeight).toBeLessThan(DEFAULT_GEOMETRY.textHeight);
  });

  it("lets the two side margins differ", () => {
    // A gutter for a punch hole is the whole reason these are separate.
    const gutter = resolveGeometry({
      ...DEFAULT_PAGE_SETUP,
      marginLeft: 90,
      marginRight: 36,
    });

    expect(gutter.textWidth).toBeCloseTo(595.28 - 90 - 36, 2);
    expect(gutter.marginLeft).toBe(90);
    expect(gutter.marginRight).toBe(36);
  });

  it("clamps a margin that is past either end", () => {
    const tiny = resolveGeometry({ ...DEFAULT_PAGE_SETUP, marginTop: 0 });
    expect(tiny.marginTop).toBe(MIN_MARGIN);

    const huge = resolveGeometry({ ...DEFAULT_PAGE_SETUP, marginTop: 5000 });
    expect(huge.marginTop).toBe(MAX_MARGIN);
  });

  it("falls back rather than closing the text column", () => {
    // Both at the maximum leaves 595.28 - 432 = 163pt, under the floor. A
    // negative or hairline column would draw the memo inside out.
    const closed = resolveGeometry({
      ...DEFAULT_PAGE_SETUP,
      marginLeft: MAX_MARGIN,
      marginRight: MAX_MARGIN,
    });

    expect(closed.marginLeft).toBe(DEFAULT_PAGE_SETUP.marginLeft);
    expect(closed.marginRight).toBe(DEFAULT_PAGE_SETUP.marginRight);
    expect(closed.textWidth).toBeCloseTo(DEFAULT_GEOMETRY.textWidth, 2);
  });

  it("survives nonsense without throwing", () => {
    const junk = resolveGeometry({
      paper: "FOOLSCAP" as PageSetup["paper"],
      marginLeft: Number.NaN,
      marginRight: Number.POSITIVE_INFINITY,
      marginTop: -10,
      marginBottom: Number.NaN,
    });

    expect(junk.paper).toBe("A4");
    expect(junk.textWidth).toBeGreaterThan(0);
    expect(junk.textHeight).toBeGreaterThan(0);
  });

  it("knows the default from a change, so nothing is recorded needlessly", () => {
    expect(isDefaultSetup(DEFAULT_PAGE_SETUP)).toBe(true);
    expect(isDefaultSetup({ ...DEFAULT_PAGE_SETUP, marginLeft: 43.3 })).toBe(false);
    expect(isDefaultSetup({ ...DEFAULT_PAGE_SETUP, paper: "LETTER" })).toBe(false);
  });
});

describe("what the default draws", () => {
  it("is byte-identical to passing no page at all", async () => {
    /*
     * The guarantee the four filed memos depend on.
     *
     * Their checksums were taken from documents drawn before page setup
     * existed. Anything that moves by a point here - a rounding difference, a
     * margin read from the wrong side - invalidates them, and the audit trail
     * cites those checksums.
     */
    const withoutPage = await renderMemo(FUEL_REQUEST);
    const withDefault = await renderMemo({
      ...FUEL_REQUEST,
      page: DEFAULT_PAGE_SETUP,
    });

    expect(withDefault.equals(withoutPage)).toBe(true);
  });

  it("draws a different document once the page changes", async () => {
    // The other half of the claim: the setting is not being ignored.
    const a4 = await renderMemo(FUEL_REQUEST);
    const letter = await renderMemo({
      ...FUEL_REQUEST,
      page: { ...DEFAULT_PAGE_SETUP, paper: "LETTER" },
    });

    expect(letter.equals(a4)).toBe(false);
  });

  it("puts the page itself at the size that was asked for", async () => {
    const { PDFDocument } = await import("pdf-lib");

    for (const paper of ["A4", "LETTER"] as const) {
      const rendered = await renderMemo({
        ...FUEL_REQUEST,
        page: { ...DEFAULT_PAGE_SETUP, paper },
      });

      const page = (await PDFDocument.load(rendered)).getPage(0);
      expect(page.getWidth()).toBeCloseTo(PAPER[paper].width, 1);
      expect(page.getHeight()).toBeCloseTo(PAPER[paper].height, 1);
    }
  });

  it("moves every line right by exactly what the left margin gained", async () => {
    /*
     * The assertion that catches a margin applied to the wrap width but not
     * to the drawing position - which re-flows the text into a narrower
     * column while leaving it pinned to the old left edge, and looks almost
     * right until you measure it.
     *
     * Both side margins move together by the same amount so the column keeps
     * its width: the text then wraps identically and every run is the same
     * run, just further right. A one-sided change would re-wrap and the runs
     * would not correspond.
     */
    const GAIN = 20;

    const before = await renderMemo(FUEL_REQUEST);
    const after = await renderMemo({
      ...FUEL_REQUEST,
      page: {
        ...DEFAULT_PAGE_SETUP,
        marginLeft: DEFAULT_PAGE_SETUP.marginLeft + GAIN,
        marginRight: DEFAULT_PAGE_SETUP.marginRight - GAIN,
      },
    });

    const one = drawnTextOnPage(before, 1);
    const two = drawnTextOnPage(after, 1);

    expect(one.length).toBeGreaterThan(20);
    expect(two).toHaveLength(one.length);

    const shifts = new Set(
      one.map((run, at) => Number((two[at].x - run.x).toFixed(2)))
    );

    // Everything on the page moved, and all of it by the same amount.
    expect([...shifts]).toEqual([GAIN]);

    // Vertically untouched: the top margin did not change.
    const drops = new Set(
      one.map((run, at) => Number((two[at].y - run.y).toFixed(2)))
    );
    expect([...drops]).toEqual([0]);
  });

  it("starts the memo lower down when the top margin grows", async () => {
    const DROP = 30;

    const before = await renderMemo(FUEL_REQUEST);
    const after = await renderMemo({
      ...FUEL_REQUEST,
      page: {
        ...DEFAULT_PAGE_SETUP,
        marginTop: DEFAULT_PAGE_SETUP.marginTop + DROP,
      },
    });

    const first = drawnTextOnPage(before, 1)[0];
    const moved = drawnTextOnPage(after, 1)[0];

    // pdf-lib measures up from the bottom, so a bigger top margin is a
    // smaller y.
    expect(Number((first.y - moved.y).toFixed(2))).toBe(DROP);
    expect(moved.x).toBeCloseTo(first.x, 2);
  });
});
