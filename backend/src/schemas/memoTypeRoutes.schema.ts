import { z } from "zod";

/** Setting or clearing the route a kind of memo starts from. */
export const memoTypeRouteSchema = z.object({
  params: z.object({
    key: z.string().trim().min(1).max(64),
  }),
  body: z
    .object({
      /** The workflow template to pick first, or null for none. */
      templateId: z.uuid("Choose a workflow from the list.").nullable(),
    })
    .strict(),
});
