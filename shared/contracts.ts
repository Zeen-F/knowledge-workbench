import { z } from "zod";

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
export type Capture = {
  id: string;
  path: string;
  ref: SourceRef;
  text: string;
  version?: string;
};
export type BatchSnapshot = {
  schema: "batch-snapshot/v1";
  id: string;
  createdAt: string;
  executor: "api" | "codex";
  instruction: string;
  sources: Capture[];
  references: { path: string; hash: string; title: string; content: string }[];
  inputHash: string;
};
export const draftProposalSchema = z
  .object({
    title: z.string().min(1).max(200),
    action: z.enum(["create", "amend"]),
    targetPath: relativePathSchema.optional(),
    baseHash: hashSchema.optional(),
    noteType: z.enum(["concept", "learning-log"]).default("concept"),
    markdown: z.string().min(1).max(500000),
    sourceIds: z.array(z.string().uuid()).min(1),
    unresolved: z.array(z.string().max(2000)).max(50).default([]),
  })
  .refine(
    (p) => p.action !== "amend" || Boolean(p.targetPath && p.baseHash),
    "修改必须携带目标笔记和原版本",
  );
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
};
export type Job = {
  id: string;
  state: string;
  executor: string;
  createdAt: string;
  error: string | null;
  snapshot: BatchSnapshot;
  items: {
    sourceId: string;
    state: string;
    output: string | null;
    error: string | null;
  }[];
};
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
  capture(): Promise<void>;
  invoke(method: string, route: string, body?: unknown): Promise<any>;
  openExternal(url: string): Promise<void>;
  onFlush(callback: () => Promise<void>): () => void;
  onCapture(callback: () => void): () => void;
}
declare global {
  interface Window {
    workbench?: DesktopBridge;
  }
}
