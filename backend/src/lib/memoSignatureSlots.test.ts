import { describe, expect, it } from "vitest";

import {
  SLOT_DATE_LANE,
  findSignatureSlot,
  placementForSlot,
  placementIsInSlot,
  slotOwnerAt,
} from "./memoSignatureSlots";
import type { MemoSignatureSlot } from "./memoTemplate";

const slot: MemoSignatureSlot = {
  key: "user-1",
  name: "Rizwan Mushtaq",
  page: 1,
  x: 100,
  y: 600,
  width: 150,
  height: 34,
};

const placement = (over: Partial<Record<string, number>> = {}) => ({
  signaturePage: 1,
  signatureX: 100,
  signatureY: 600,
  signatureWidth: 150,
  signatureHeight: 23,
  ...over,
});

describe("recognising a signature placed on its own line", () => {
  it("accepts the slot sent back unchanged", () => {
    expect(placementIsInSlot(placement(), slot)).toBe(true);
  });

  it("accepts a box the signer nudged a few points", () => {
    // Somebody dragging a box by hand will not reproduce the rectangle to the
    // point. Demanding equality would quietly drop them back to the
    // free-floating behaviour this exists to replace.
    expect(placementIsInSlot(placement({ signatureX: 104 }), slot)).toBe(true);
  });

  it("refuses a box centred outside the line", () => {
    expect(placementIsInSlot(placement({ signatureX: 400 }), slot)).toBe(false);
    expect(placementIsInSlot(placement({ signatureY: 200 }), slot)).toBe(false);
  });

  it("refuses the same rectangle on a different page", () => {
    // Two-page memos put the strip on the last page; a signature at those
    // coordinates on page one is somewhere in the body.
    expect(placementIsInSlot(placement({ signaturePage: 2 }), slot)).toBe(false);
  });
});

describe("the box a slotted signature is drawn into", () => {
  it("snaps to the printed line", () => {
    const fitted = placementForSlot(slot);

    expect(fitted.signaturePage).toBe(1);
    expect(fitted.signatureX).toBe(slot.x);
    expect(fitted.signatureY).toBe(slot.y);
    expect(fitted.signatureWidth).toBe(slot.width);
  });

  it("stops short of the line, leaving room for the date", () => {
    // The stamping path draws the date below the image box. Using the whole
    // slot would write it across the ruled line and the printed name.
    expect(placementForSlot(slot).signatureHeight).toBe(
      slot.height - SLOT_DATE_LANE
    );
  });

  it("never produces a box of zero or negative height", () => {
    const tiny = placementForSlot({ ...slot, height: 4 });
    expect(tiny.signatureHeight).toBeGreaterThan(0);
  });
});

describe("reading a version's recorded strip", () => {
  it("finds the reader's own column", () => {
    const found = findSignatureSlot([slot, { ...slot, key: "user-2" }], "user-1");
    expect(found?.name).toBe("Rizwan Mushtaq");
  });

  it("gives nothing for somebody who is not on the strip", () => {
    expect(findSignatureSlot([slot], "somebody-else")).toBeNull();
  });

  /*
   * This is a JSON column, so its contents are whatever some build of the
   * renderer wrote - including builds that do not exist yet. Every shape
   * below has to produce "no slot" rather than an exception: a memo whose
   * slots cannot be read is still perfectly signable by hand, which is what
   * every uploaded memo does, and refusing to open it would be a far worse
   * answer than declining to offer a convenience.
   */
  it.each([
    ["null", null],
    ["an uploaded memo's empty column", undefined],
    ["an object where a list was expected", { key: "user-1" }],
    ["a list of nothing", [null]],
    ["a slot with no geometry", [{ key: "user-1", name: "X" }]],
    ["a slot with text where numbers go", [{ ...slot, x: "100" }]],
    ["a slot with a NaN coordinate", [{ ...slot, y: Number.NaN }]],
  ])("gives nothing for %s", (_label, stored) => {
    expect(findSignatureSlot(stored, "user-1")).toBeNull();
  });
});

describe("whose line a placement lands on", () => {
  const strip: MemoSignatureSlot[] = [
    { key: "user-1", name: "Rizwan Mushtaq", page: 1, x: 100, y: 600, width: 150, height: 34 },
    { key: "user-2", name: "Maryam Ali", page: 1, x: 300, y: 600, width: 150, height: 34 },
    { key: "user-3", name: "BMD", page: 1, x: 500, y: 600, width: 150, height: 34 },
  ];

  it("names the owner of the line a signature is aimed at", () => {
    expect(slotOwnerAt(strip, placement({ signatureX: 300 }))).toBe("user-2");
  });

  it("names the last approver when the final column is targeted", () => {
    // The case the guard exists for: an approver at step two posting the
    // coordinates printed for the person who signs after them.
    expect(slotOwnerAt(strip, placement({ signatureX: 500 }))).toBe("user-3");
  });

  it("says nobody for a signature in open space", () => {
    // Where every uploaded memo's signature goes. Not something this has an
    // opinion about - it must not start refusing the path that has no strip.
    expect(slotOwnerAt(strip, placement({ signatureY: 200 }))).toBeNull();
  });

  it("says nobody when the page has no strip at all", () => {
    expect(slotOwnerAt(null, placement())).toBeNull();
    expect(slotOwnerAt([], placement())).toBeNull();
  });

  it("ignores a row that is not a slot", () => {
    // The column is JSON written by whatever build of the renderer filed the
    // memo. A row it cannot read must not be treated as a line belonging to
    // nobody, which would refuse every signature on the page.
    expect(slotOwnerAt([null, "nonsense", { key: 7 }], placement())).toBeNull();
  });

  it("ignores a slot whose geometry is missing", () => {
    expect(slotOwnerAt([{ key: "user-9", page: 1, x: 100 }], placement())).toBeNull();
  });

  it("tells a signer's own line apart from the one beside it", () => {
    const own = slotOwnerAt(strip, placement({ signatureX: 100 }));
    const neighbour = slotOwnerAt(strip, placement({ signatureX: 300 }));

    expect(own).toBe("user-1");
    expect(neighbour).not.toBe(own);
  });

  it("does not match a line on another page", () => {
    expect(slotOwnerAt(strip, placement({ signaturePage: 2 }))).toBeNull();
  });
})
