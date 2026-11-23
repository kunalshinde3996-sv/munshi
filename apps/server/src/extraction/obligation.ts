import { createHash } from "node:crypto";
import { z } from "zod";

export const OBLIGATION_TYPES = ["bill", "deadline", "renewal", "refund", "appointment", "travel", "other"] as const;

const plainText = (max: number) => z.string().trim().min(1).max(max);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/, "dueDate must be ISO 8601");

/** What the Quarantined Extractor LLM must return per obligation. */
export const ExtractedObligation = z.object({
  type: z.enum(OBLIGATION_TYPES),
  title: plainText(120),
  dueDate: isoDate.nullish().transform((v) => v ?? undefined),
  amount: z.number().nonnegative().nullish().transform((v) => v ?? undefined),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? undefined),
  counterparty: plainText(80).nullish().transform((v) => v ?? undefined),
  confidence: z.number().min(0).max(1),
  evidenceQuote: z.string().trim().min(1).max(200),
});
export type ExtractedObligation = z.infer<typeof ExtractedObligation>;

export const ExtractionOutput = z.object({ obligations: z.array(z.unknown()) });

/** Validated obligation, the only email-derived object the Agent LLM ever sees. */
export const Obligation = ExtractedObligation.extend({
  id: z.string(),
  emailId: z.string(),
});
export type Obligation = z.infer<typeof Obligation>;

export function obligationId(emailId: string, o: ExtractedObligation): string {
  const h = createHash("sha1").update(`${emailId}|${o.type}|${o.title}|${o.dueDate ?? ""}`).digest("hex");
  return `obl-${h.slice(0, 12)}`;
}
