import { z } from "zod";
import {
  codexReviewAnchorSchema,
  codexRevisionCommentSchema,
  maxRevisionComments,
} from "../shared/contracts";

const feedbackSchema = z.object({
  instruction: z.string().max(10000),
  anchor: codexReviewAnchorSchema.optional(),
  comments: z.array(codexRevisionCommentSchema).max(maxRevisionComments),
  editing: z.number().int().nonnegative().optional(),
  request: z.object({ key: z.string(), id: z.string().uuid() }).optional(),
});
export type ReviewFeedback = z.infer<typeof feedbackSchema>;

export const emptyReviewFeedback: ReviewFeedback = {
  instruction: "",
  comments: [],
};

export function readReviewFeedback(key: string): ReviewFeedback {
  try {
    const value = feedbackSchema.safeParse(
      JSON.parse(localStorage.getItem(key) || "null"),
    );
    if (value.success) return value.data;
  } catch {
    // Editing remains available when the embedded browser has no storage.
  }
  return emptyReviewFeedback;
}

export function writeReviewFeedback(key: string, value: ReviewFeedback) {
  try {
    if (
      value.instruction ||
      value.anchor ||
      value.comments.length ||
      value.request
    )
      localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    // The review page retains a live copy while it is open.
  }
}

export function commentsToSubmit(value: ReviewFeedback) {
  const text = value.instruction.trim();
  if (!text) return value.comments;
  const comment = value.anchor ? { text, anchor: value.anchor } : { text };
  if (value.editing === undefined) return [...value.comments, comment];
  return value.comments.map((entry, index) =>
    index === value.editing ? comment : entry,
  );
}

export function clearCurrentOpinion(value: ReviewFeedback): ReviewFeedback {
  return { comments: value.comments, instruction: "" };
}

export function enqueueOpinion(value: ReviewFeedback): ReviewFeedback {
  return { instruction: "", comments: commentsToSubmit(value) };
}
