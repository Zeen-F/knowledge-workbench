import { z } from "zod";

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const codexModelSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
export const codexOptionsSchema = z
  .object({
    model: codexModelSchema.optional(),
    effort: reasoningEffortSchema.optional(),
    fast: z.boolean(),
  })
  .strict();
export type CodexOptions = z.infer<typeof codexOptionsSchema>;

export type CodexModelChoice = {
  id: string;
  name: string;
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  supportsFast: boolean;
};
export type CodexCatalog = {
  models: CodexModelChoice[];
  defaults: CodexOptions;
};

export const defaultCodexOptions: CodexOptions = { fast: false };
