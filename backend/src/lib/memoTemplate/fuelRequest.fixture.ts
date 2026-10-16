/**
 * The sample memo, as data.
 *
 * This is the Fuel Request memo from the brief, typed out as the editor would
 * store it. It is the template's reference case: if this renders as the Word
 * original does, the template is right; when it stops doing so, something has
 * regressed.
 */
import type { MemoBody, RenderMemoInput } from "./types";

const text = (value: string, marks?: ("bold" | "italic" | "underline")[]) => ({
  type: "text" as const,
  text: value,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
});

const para = (...content: ReturnType<typeof text>[]) => ({
  type: "paragraph" as const,
  content,
});

const cell = (value: string) => ({
  type: "tableCell" as const,
  content: [para(text(value))],
});

const head = (value: string) => ({
  type: "tableHeader" as const,
  content: [para(text(value))],
});

export const FUEL_REQUEST_BODY: MemoBody = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("BACKGROUND:")] },

    para(
      text("It is submitted for management’s kind consideration that "),
      text("Mr. Inayat Hussain (AX-1644), Security Executive", ["bold"]),
      text(
        ", has requested a revision of his monthly Fuel and Motorcycle Maintenance Allowance due to the increased operational responsibilities assigned to him."
      )
    ),

    para(
      text(
        "Mr. Inayat is responsible for field operations across Karachi, including store visits, coordination with law enforcement agencies, obtaining NOCs, verification activities, and other official assignments that require extensive travel using his personal motorcycle."
      )
    ),

    para(
      text("Previously, these operational activities were managed by "),
      text("two Security Executives", ["bold"]),
      text(", with each employee receiving "),
      text("50 liters of fuel allowance per month", ["bold"]),
      text(" and "),
      text("PKR 1,500 per month as motorcycle maintenance allowance", ["bold"]),
      text(
        ". Following the reduction in manpower, the same operational coverage is now being managed solely by Mr. Inayat Hussain, resulting in significantly increased travel, fuel consumption, and motorcycle maintenance expenses."
      )
    ),

    para(
      text(
        "The concerned department has therefore requested an enhancement in his monthly Fuel Allowance from "
      ),
      text("50 liters", ["bold"]),
      text(" to "),
      text("75 liters", ["bold"]),
      text(" and Motorcycle Maintenance Allowance from "),
      text("PKR 1,500 to PKR 2,500", ["bold"]),
      text(" to support his increased operational responsibilities.")
    ),

    { type: "heading", attrs: { level: 2 }, content: [text("Employee Details:")] },

    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            head("AX ID"),
            head("Employee Name"),
            head("Designation"),
            head("Department"),
            head("Current Fuel Allowance"),
            head("Proposed Fuel Allowance"),
            head("Current Maintenance"),
            head("Proposed Maintenance"),
          ],
        },
        {
          type: "tableRow",
          content: [
            cell("1644"),
            cell("Inayat Hussain"),
            cell("Security Executive"),
            cell("Security & Loss Prevention"),
            cell("50 Liters/Month"),
            cell("75 Liters/Month"),
            cell("PKR 1,500/Month"),
            cell("PKR 2,500/Month"),
          ],
        },
      ],
    },

    { type: "heading", attrs: { level: 2 }, content: [text("Recommendation")] },

    para(
      text(
        "Considering the increased operational workload resulting from the reduction of field resources and the nature of Mr. Inayat Hussain’s responsibilities, it is recommended that his monthly "
      ),
      text("Fuel Allowance be revised from 50 liters to 75 liters", ["bold"]),
      text(" and "),
      text(
        "Motorcycle Maintenance Allowance be increased from PKR 1,500 to PKR 2,500",
        ["bold"]
      ),
      text(
        ", effective upon management approval, to ensure the smooth execution of official field operations."
      )
    ),
  ],
};

export const FUEL_REQUEST: RenderMemoInput = {
  header: {
    to: "Sir BMD",
    from: "Human Resource Department",
    subject:
      "Approval for Revision of Fuel & Motorcycle Maintenance Allowance – Mr. Inayat Hussain (AX-1644)",
    date: new Date(Date.UTC(2026, 7, 6)),
  },
  body: FUEL_REQUEST_BODY,
  branding: { organisationName: "Ideas Pvt Ltd" },
  signatories: [
    { name: "Rizwan Mushtaq", designation: "Director - Human Resources" },
    { name: "Maryam Ali", designation: "Director - Audit" },
    { name: "BMD", designation: "Chairman" },
  ],
};
