/**
 * Refuse a memo the fonts cannot draw.
 *
 * This exists because of something the proof sheet showed and the
 * measurement API did not: `widthOfTextAtSize` returns a perfectly good
 * number for Urdu, and the page then renders six identical empty boxes. Plus
 * Jakarta Sans has no Arabic script.
 *
 * Silently drawing boxes is the worse failure. The generated PDF is written
 * once, digested, recorded against the version row and sent into an approval
 * chain - so the tofu would be sealed into the artefact, signed by four
 * people, and discovered by whoever eventually printed it. A submission that
 * fails with a readable message costs the preparer a minute.
 */
import { errors } from "../errors";
import { DEFAULT_FONT_FAMILY, allFontKeys, supportedCodePoints } from "./assets";
import type {
  MemoBlockNode,
  MemoTextNode,
  RenderMemoInput,
} from "./types";

/** Control characters are not missing glyphs; they are simply not drawn. */
function isIgnorable(codePoint: number): boolean {
  return (
    codePoint === 0x09 || // tab
    codePoint === 0x0a || // newline
    codePoint === 0x0d || // carriage return
    codePoint === 0x200b || // zero-width space
    codePoint === 0xfeff // byte-order mark
  );
}

function collectText(nodes: MemoTextNode[] | undefined): string {
  return (nodes ?? []).map((node) => node.text).join("");
}

function textOfBlock(node: MemoBlockNode): string {
  switch (node.type) {
    case "pageBreak":
      return "";
    case "image":
      // The description is for a screen reader in the editor; nothing of
      // it is drawn, so no glyph is needed for it.
      return "";
    case "paragraph":
    case "heading":
      return collectText(node.content);
    case "bulletList":
    case "orderedList":
      return node.content
        .flatMap((item) => item.content.map((p) => collectText(p.content)))
        .join(" ");
    case "table":
      return node.content
        .flatMap((row) =>
          row.content.flatMap((cell) =>
            (cell.content ?? []).map((p) => collectText(p.content))
          )
        )
        .join(" ");
  }
}

export function findUndrawableCharacters(input: RenderMemoInput): string[] {
  // The union across the family: a character only has to be drawable in the
  // face it is actually set in, and every face here shares a repertoire.
  // In the family the memo is set in: a serif and a sans do not cover the
  // same characters, and the answer has to be about the face that draws it.
  const family = input.body.attrs?.font ?? DEFAULT_FONT_FAMILY;
  const covered = allFontKeys().reduce<Set<number>>((all, key) => {
    for (const point of supportedCodePoints(key, family)) all.add(point);
    return all;
  }, new Set<number>());

  const text = [
    input.header.to,
    input.header.from,
    input.header.subject,
    input.header.reference ?? "",
    input.branding.organisationName,
    ...input.signatories.flatMap((s) => [s.name, s.designation ?? ""]),
    ...input.body.content.map(textOfBlock),
  ].join(" ");

  const missing = new Set<string>();

  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (isIgnorable(point) || covered.has(point)) continue;
    missing.add(char);
  }

  return [...missing];
}

export function assertRenderable(input: RenderMemoInput): void {
  const missing = findUndrawableCharacters(input);
  if (missing.length === 0) return;

  const shown = missing.slice(0, 8).join(" ");
  const more = missing.length > 8 ? ` (and ${missing.length - 8} more)` : "";

  /*
   * A 400, not a 500.
   *
   * Somebody pasted a rupee sign or a line of Urdu into the body: their
   * request is the thing that is wrong, and the sentence below tells them
   * how to fix it. Thrown as a plain Error it reached the error handler as
   * an unexpected failure, which answers "Internal server error" and drops
   * the explanation - so the preparer would be told only that something
   * broke, about the one problem this check exists to explain.
   */
  throw errors.badRequest(
    `This memo contains characters the document font cannot print: ${shown}${more}. ` +
      `They would appear as empty boxes in the filed PDF. Remove or replace ` +
      `them and submit again.`
  );
}
