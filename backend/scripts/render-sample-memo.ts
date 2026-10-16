/**
 * Render the reference memo to a file, so it can be looked at.
 *
 *   npx tsx scripts/render-sample-memo.ts out.pdf [signatoryCount]
 *
 * A template is not finished when its tests pass; it is finished when
 * somebody has looked at the page. Tests catch a table that lost a column,
 * not a heading orphaned at a page foot or a signature strip that collides
 * with the last paragraph.
 */
import fs from "node:fs";

import { FUEL_REQUEST } from "../src/lib/memoTemplate/fuelRequest.fixture";
import { renderMemo } from "../src/lib/memoTemplate";

const target = process.argv[2] ?? "sample-memo.pdf";
const signatoryCount = Number(process.argv[3] ?? 0);
/**
 * Repeat the body N times to force the memo over a page boundary. One page
 * never exercises the parts most likely to be wrong: the table header
 * repeating, the continuation caption, the page numbers, and a signature
 * strip that has to find room on a page that is already full.
 */
const repeat = Math.max(1, Number(process.argv[4] ?? 1));

const EXTRA = [
  { name: "SBK", designation: "Chief Operating Officer" },
  { name: "Adnan Mumtaz", designation: "Head of Administration" },
  { name: "Reham Nawaz", designation: "Internal Audit" },
];

const input = { ...FUEL_REQUEST };

if (signatoryCount > 0) {
  const pool = [...FUEL_REQUEST.signatories, ...EXTRA];
  input.signatories = pool.slice(0, signatoryCount);
}

if (repeat > 1) {
  input.header = {
    ...FUEL_REQUEST.header,
    reference: "MEMO-2026-0007",
  };
  input.body = {
    ...FUEL_REQUEST.body,
    content: Array.from({ length: repeat }, () => FUEL_REQUEST.body.content).flat(),
  };
}

// Wrapped rather than top-level: this package compiles to CommonJS, where
// esbuild refuses a top-level await outright.
async function main(): Promise<void> {
  const started = Date.now();
  const pdf = await renderMemo(input);
  fs.writeFileSync(target, pdf);

  console.log(`wrote ${target}`);
  console.log(`  ${pdf.length.toLocaleString()} bytes`);
  console.log(`  ${input.signatories.length} signatories`);
  console.log(`  rendered in ${Date.now() - started}ms`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
