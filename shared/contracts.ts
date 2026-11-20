import { z } from "zod";
import type { ResearchProfileSnapshot } from "./research-profiles.ts";
import { codexOptionsSchema, type CodexOptions } from "./codex-options.ts";

export const PRODUCT = "knowledge-workbench";
export const API_VERSION = 1;
export const MANAGED = "KnowledgeWorkbench";
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const relativePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.startsWith("/") &&
      !p
        .split("/")
        .some(
          (s) =>
            s === ".." ||
            s === "." ||
            !s ||
            /[. ]$/.test(s) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
        ) &&
      !/[<>:"|?*\x00-\x1f]/.test(p),
    "路径必须是知识库内可用的 Windows 相对路径",
  );
export const rectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001,
    "选区超出页面",
  );
export const deletedNoteSchema = z.object({
  id: z.string().uuid(),
  path: relativePathSchema,
  hash: hashSchema,
});
export type DeletedNote = z.infer<typeof deletedNoteSchema>;
export const paperdeskRefSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string().max(1000),
  pdfSha256: hashSchema,
  pdfPath: relativePathSchema.optional(),
  notePath: relativePathSchema.optional(),
  page: z.number().int().positive(),
  rects: z.array(rectSchema).max(100),
  quote: z.string().max(100000).default(""),
});
export const sourceRefSchema = z.object({
  schema: z.literal("source-ref/v1"),
  id: z.string().uuid(),
  kind: z.enum(["image", "text", "paperdesk"]),
  capturedAt: z.string(),
  title: z.string().max(1000),
  assetPath: relativePathSchema.optional(),
  sha256: hashSchema.optional(),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
  paperdesk: paperdeskRefSchema.optional(),
  transferId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type NoteSummary = {
  id: string;
  path: string;
  title: string;
  noteType: string;
  domain: string;
  status: string;
  hash: string;
  updatedAt: string;
  tags: string[];
  owner: "workbench" | "paperdesk" | "external";
  missing?: boolean;
};
export type Note = NoteSummary & {
  content: string;
  metadata: Record<string, unknown>;
  paperdeskId?: string;
  body?: string;
  draft?: { content: string; baseHash: string; savedAt: string };
};
export const childNoteParentSchema = z.object({
  path: relativePathSchema,
  expectedHash: hashSchema,
  offset: z.number().int().nonnegative(),
  placement: z.enum(["inline", "block"]).optional(),
  requestId: z.string().uuid(),
});
export type ChildNoteParent = z.infer<typeof childNoteParentSchema>;
export type ChildNoteResult = {
  child: Note;
  parent: Note;
  insertion?: { offset: number; text: string };
};
export type CollectionTask = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  ended: boolean;
  count: number;
};
export type Capture = {
  id: string;
  path: string;
  ref: SourceRef;
  text: string;
  version?: string;
};
export const batchExecutorSchema = z.enum(["codex-cli", "api", "codex"]);
export type BatchExecutor = z.infer<typeof batchExecutorSchema>;
export const MAX_OPTIMIZATION_REFERENCES = 10;
export const noteOptimizationInputSchema = z.object({
  path: relativePathSchema,
  scope: z.enum(["workbench", "vault"]),
  referencePaths: z.array(relativePathSchema).max(MAX_OPTIMIZATION_REFERENCES),
  instruction: z.string().max(2000),
  codexOptions: codexOptionsSchema.optional(),
});
export type NoteOptimizationInput = z.infer<typeof noteOptimizationInputSchema>;
export type CodexCliStatus = "ready" | "missing" | "signed-out" | "unavailable";
export type NoteReference = {
  path: string;
  hash: string;
  title: string;
  content: string;
};
export type NoteAnnotation = {
  line: number;
  text: string;
  nearbyImage?: number;
};
export type NoteImage = {
  path: string;
  line: number;
  hash: string;
  mime: string;
};
export type NoteImageIssue = {
  line: number;
  detail: string;
};
export const codexReviewAnchorSchema = z.object({
  text: z.string().trim().min(1).max(6000),
  offset: z.number().int().nonnegative().max(500000),
  line: z.number().int().positive().max(500001),
  column: z.number().int().positive().max(500001).optional(),
});
export type CodexReviewAnchor = z.infer<typeof codexReviewAnchorSchema>;
export const codexRevisionCommentSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  anchor: codexReviewAnchorSchema.optional(),
});
export type CodexRevisionComment = z.infer<typeof codexRevisionCommentSchema>;
export const maxRevisionComments = 50;
export const codexReviewInputSchema = z
  .object({
    mode: z.enum(["chat", "revision"]),
    quote: z.string().trim().max(6000).optional(),
    comments: z
      .array(codexRevisionCommentSchema)
      .min(1)
      .max(maxRevisionComments)
      .optional(),
    codexOptions: codexOptionsSchema.optional(),
  })
  .refine((review) => !review.comments || review.mode === "revision");
export type CodexReviewInput = z.infer<typeof codexReviewInputSchema>;
export type BatchSnapshot = {
  schema: "batch-snapshot/v1";
  taskId?: string;
  id: string;
  createdAt: string;
  executor: BatchExecutor;
  codexOptions?: CodexOptions;
  instruction: string;
  sources: Capture[];
  references: NoteReference[];
  noteRevision?: NoteReference & {
    noteType: "concept" | "learning-log";
    annotations?: NoteAnnotation[];
    images?: NoteImage[];
    imageIssues?: NoteImageIssue[];
  };
  researchProfile?: ResearchProfileSnapshot;
  codexFollowUp?: {
    rootJobId: string;
    proposalId: string;
    draftHash: string;
    base: DraftProposal;
    mode?: CodexReviewInput["mode"];
    quote?: string;
    comments?: CodexRevisionComment[];
  };
  inputHash: string;
};
export type BatchPreview = Omit<
  BatchSnapshot,
  "schema" | "id" | "createdAt" | "inputHash"
> & { previewHash: string };
const annotationResponsesSchema = z
  .array(
    z.object({
      line: z.number().int().positive(),
      state: z.enum(["answered", "needs-context"]),
      response: z.string().trim().min(1).max(6000),
    }),
  )
  .max(80);
export const childNoteDraftSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value)),
  markdown: z.string().min(1).max(160000),
});
export type ChildNoteDraft = z.infer<typeof childNoteDraftSchema>;
const childNotesSchema = z.array(childNoteDraftSchema).max(20).optional();
export const noteRevisionResultSchema = z.object({
  markdown: z.string().min(1).max(500000),
  unresolved: z.array(z.string().max(2000)).max(50).default([]),
  annotationResponses: annotationResponsesSchema.optional(),
  childNotes: childNotesSchema,
});
export const draftProposalSchema = z
  .object({
    title: z.string().min(1).max(200),
    action: z.enum(["create", "amend"]),
    targetPath: relativePathSchema.optional(),
    baseHash: hashSchema.optional(),
    noteType: z.enum(["concept", "learning-log"]).default("concept"),
    markdown: noteRevisionResultSchema.shape.markdown,
    sourceIds: z.array(z.string().uuid()).min(1),
    unresolved: noteRevisionResultSchema.shape.unresolved,
    childNotes: childNotesSchema,
  })
  .refine(
    (p) => p.action !== "amend" || Boolean(p.targetPath && p.baseHash),
    "修改必须携带目标笔记和原版本",
  );
export const noteRevisionDraftSchema = draftProposalSchema.safeExtend({
  action: z.literal("amend"),
  targetPath: relativePathSchema,
  baseHash: hashSchema,
  sourceIds: z.array(z.string().uuid()).length(0),
  annotationResponses: annotationResponsesSchema.optional(),
});
export const storedProposalSchema = z.union([
  draftProposalSchema,
  noteRevisionDraftSchema,
]);
export type DraftProposal = z.infer<typeof draftProposalSchema>;
export type Proposal = DraftProposal & {
  id: string;
  jobId: string;
  status: "pending" | "accepted" | "rejected";
  path: string;
  acceptedPath?: string;
  draftHash: string;
  recovery?: string;
  unavailable?: string;
  supersededBy?: string;
  revising?: boolean;
  legacyChildren?: boolean;
  annotationResponses?: z.infer<typeof annotationResponsesSchema>;
};
export type Job = {
  id: string;
  state: string;
  executor: BatchExecutor;
  createdAt: string;
  error: string | null;
  codexThreadId?: string;
  snapshot: BatchSnapshot;
  items: {
    sourceId: string;
    state: string;
    output: string | null;
    error: string | null;
  }[];
};

export type CodexConversation = {
  rootJobId: string;
  threadId?: string;
  title: string;
  turns: {
    jobId: string;
    at: string;
    instruction: string;
    state: string;
    error: string | null;
    followUp: boolean;
    mode?: CodexReviewInput["mode"];
    quote?: string;
    comments?: CodexRevisionComment[];
    baseId?: string;
    codexOptions?: CodexOptions;
    answer?: string;
    replies: { id: string; title: string; markdown: string }[];
  }[];
};
export function codexRootJob(job: Pick<Job, "id" | "snapshot">) {
  return job.snapshot.codexFollowUp?.rootJobId || job.id;
}
export const providerSchema = z.object({
  baseUrl: z.string().url(),
  protocol: z.enum(["responses", "chat-completions"]),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(10000).optional(),
});
export type Provider = z.infer<typeof providerSchema>;
export const transferSchema = z.object({
  schema: z.literal("paperdesk-capture/v1"),
  id: z.string().uuid(),
  createdAt: z.iso.datetime(),
  source: paperdeskRefSchema,
  comment: z.string().max(20000).default(""),
  image: z
    .object({
      file: z.literal("selection.png"),
      sha256: hashSchema,
      mime: z.literal("image/png"),
    })
    .optional(),
});

export interface DesktopBridge {
  panel?: boolean;
  sendToCodex?(text: string): Promise<void>;
  chooseVault(): Promise<void>;
  capture(taskId?: string): Promise<void>;
  invoke(method: string, route: string, body?: unknown): Promise<any>;
  invokeResult?(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{
    data?: unknown;
    error?: string;
    code?: string;
    status?: number;
    details?: unknown;
  }>;
  openExternal(url: string): Promise<void>;
  onFlush(callback: () => Promise<void>): () => void;
  onCapture(callback: () => void): () => void;
  onCollectionRequested?(callback: () => void): () => void;
  onShortcutRecorded?(callback: (accelerator: string) => void): () => void;
}
declare global {
  interface Window {
    workbench?: DesktopBridge;
  }
}
