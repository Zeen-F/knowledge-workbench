import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  codexRootJob,
  draftProposalSchema,
  noteRevisionDraftSchema,
  noteRevisionResultSchema,
  storedProposalSchema,
  type BatchExecutor,
  type BatchSnapshot,
  type BatchPreview,
  type CodexConversation,
  type CodexReviewInput,
  type CodexRevisionComment,
  type DraftProposal,
  type Job,
  type NoteOptimizationInput,
  type Proposal,
  type Provider,
} from "../shared/contracts.ts";
import { AppError, atomicWrite, digest, now, readUtf8, slug } from "./files.ts";
import { formatMarkdown, parseMarkdown } from "./markdown.ts";
import { callProvider, type ModelImages } from "./provider.ts";
import type { callCodexCli } from "./codex-cli.ts";
import type { ReviewTurnProgress } from "./codex-review.ts";
import type { CodexOptions } from "../shared/codex-options.ts";
import {
  noteOptimizationContext,
  optimizationImages,
} from "./note-optimization-context.ts";
import type { Vault } from "./vault.ts";
import {
  addNoteDirectory,
  legacyChildNotes,
  prepareChildNotes,
  validateChildNotes,
} from "./child-note-drafts.ts";
import type { Captures } from "./capture.ts";
import {
  GENERAL_PROFILE,
  researchSelectionSchema,
  researchSnapshotSchema,
  snapshotResearchProfile,
} from "../shared/research-profiles.ts";

function revisionComments(markdown: string, comments?: CodexRevisionComment[]) {
  const body = markdown.replace(/\r\n/g, "\n");
  return comments?.map((comment, index) => {
    const anchor = comment.anchor;
    if (!anchor) return comment;
    const text = anchor.text.replace(/\r\n/g, "\n");
    let offset = anchor.offset;
    if (!body.startsWith(text, offset)) {
      offset = body.indexOf(text);
      if (offset < 0 || body.indexOf(text, offset + 1) >= 0)
        throw new AppError(
          "第 " +
            (index + 1) +
            " 条意见的引用已变化，请编辑该条意见并重新引用。",
          409,
          "REVIEW_QUOTE_CHANGED",
        );
    }
    const before = body.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    return { ...comment, anchor: { text, offset, line, column } };
  });
}

export class Processing {
  running = new Map<string, AbortController>();
  accepting = new Set<string>();
  constructor(
    public vault: Vault,
    public captures: Captures,
    public getProvider: () => Promise<Provider>,
    public callLocalCodex?: typeof callCodexCli,
    private readonly readCodexDefaults?: () => CodexOptions | undefined,
  ) {}
  preview(
    sourceIds: string[],
    referencePaths: string[],
    executor: BatchExecutor,
    instruction: string,
    selection: unknown = GENERAL_PROFILE,
    taskId = "history",
    codexOptions?: CodexOptions,
  ): BatchPreview {
    if (executor === "codex-cli") {
      if (!this.callLocalCodex)
        throw new AppError("请打开桌面知识工作台使用本机 Codex CLI", 409);
      codexOptions ??= this.readCodexDefaults?.();
    }
    if (!sourceIds.length || sourceIds.length > 100)
      throw new AppError("每批请选择 1 至 100 项材料");
    if (referencePaths.length > 20)
      throw new AppError("每批最多选择 20 篇参考笔记");
    this.captures.assertScope(sourceIds, taskId);
    const sources = [...new Set(sourceIds)].map((id) => {
      if (this.captures.isDeleted(id))
        throw new AppError("材料已从收集箱删除，请先恢复后再整理", 409);
      return this.captures.snapshot(id);
    });
    // Preview and final confirmation must refer to the actual immutable image.
    for (const source of sources)
      if (source.ref.assetPath) this.captures.image(source.ref);
    if (sources.reduce((sum, s) => sum + s.text.length, 0) > 500000)
      throw new AppError("材料文字过多，请分成较小的批次");
    const references = [...new Set(referencePaths)].map((p) => {
      const n = this.vault.read(p);
      return {
        path: p,
        hash: n.hash,
        title: n.title,
        content: n.owner === "paperdesk" ? n.body || "" : n.content,
      };
    });
    if (references.reduce((sum, n) => sum + n.content.length, 0) > 150000)
      throw new AppError("参考笔记总长度超过本批限制，请缩小范围");
    const researchProfile = snapshotResearchProfile(selection);
    const data = {
      ...(taskId !== "history" ? { taskId } : {}),
      executor,
      ...(executor === "codex-cli" && codexOptions ? { codexOptions } : {}),
      instruction,
      sources,
      references,
      ...(researchProfile ? { researchProfile } : {}),
    };
    return { ...data, previewHash: digest(JSON.stringify(data)) };
  }
  create(
    sourceIds: string[],
    referencePaths: string[],
    executor: BatchExecutor,
    instruction: string,
    selection: unknown = GENERAL_PROFILE,
    expectedPreviewHash?: string,
    taskId = "history",
    codexOptions?: CodexOptions,
  ) {
    const preview = this.preview(
      sourceIds,
      referencePaths,
      executor,
      instruction,
      selection,
      taskId,
      codexOptions,
    );
    return this.persistBatch(
      preview,
      expectedPreviewHash,
      randomUUID(),
      selection,
    );
  }
  previewNoteOptimization(input: NoteOptimizationInput): BatchPreview {
    if (!this.callLocalCodex)
      throw new AppError("请打开桌面知识工作台使用本机 Codex CLI", 409);
    const read = (relative: string) => {
      if (
        (input.scope === "workbench" &&
          !relative.startsWith(`${this.vault.managed}/`)) ||
        relative.includes("/Inbox/") ||
        relative.includes("/Drafts/")
      )
        throw new AppError("请从当前知识空间选择正式笔记", 403);
      const note = this.vault.read(relative);
      if (
        note.metadata.kb_source ||
        note.metadata.kb_proposal ||
        note.metadata.kb_extraction
      )
        throw new AppError("请从当前知识空间选择正式笔记", 403);
      return note;
    };
    const note = read(input.path);
    if (note.owner === "paperdesk")
      throw new AppError("请在纸间管理文献笔记", 409, "PAPERDESK_REQUIRED");
    if (note.draft && note.draft.content !== note.content)
      throw new AppError("请先保存目标笔记的未提交编辑", 409);
    const snapshot = (note: ReturnType<Vault["read"]>) => ({
      path: note.path,
      hash: note.hash,
      title: note.title,
      content: (note.owner === "paperdesk"
        ? note.body || ""
        : parseMarkdown(note.content).body
      ).replace(/^\uFEFF/, ""),
    });
    const target = snapshot(note);
    if (!target.content.trim() || target.content.length > 150000)
      throw new AppError("目标笔记需要有正文，单篇优化最多处理 15 万字");
    const references = [...new Set(input.referencePaths)]
      .filter((relative) => relative !== input.path)
      .map((relative) => snapshot(read(relative)));
    if (
      references.reduce(
        (length, reference) => length + reference.content.length,
        0,
      ) > 150000
    )
      throw new AppError("所选参考笔记总长度超过 15 万字，请减少参考笔记");
    const codexOptions = input.codexOptions ?? this.readCodexDefaults?.();
    const data = {
      executor: "codex-cli" as const,
      ...(codexOptions ? { codexOptions } : {}),
      instruction: input.instruction,
      sources: [],
      references,
      noteRevision: {
        ...target,
        ...noteOptimizationContext(this.vault, target),
        noteType:
          note.noteType === "learning-log"
            ? ("learning-log" as const)
            : ("concept" as const),
      },
    };
    return { ...data, previewHash: digest(JSON.stringify(data)) };
  }
  createNoteOptimization(
    input: NoteOptimizationInput,
    expectedPreviewHash: string,
    requestId: string,
  ) {
    if (
      this.vault.db.prepare("SELECT id FROM jobs WHERE id=?").get(requestId)
    ) {
      const previous = this.get(requestId);
      const { schema, id, createdAt, inputHash, ...confirmed } =
        previous.snapshot;
      if (
        !confirmed.noteRevision ||
        digest(JSON.stringify(confirmed)) !== expectedPreviewHash
      )
        throw new AppError("这次确认已用于另一份优化任务", 409);
      return previous;
    }
    return this.persistBatch(
      this.previewNoteOptimization(input),
      expectedPreviewHash,
      requestId,
    );
  }
  continueWithCodex(
    proposalId: string,
    feedback: string,
    expectedHash: string,
    requestId: string,
    review?: CodexReviewInput,
  ) {
    if (!this.callLocalCodex)
      throw new AppError("请打开桌面知识工作台继续本机 Codex 对话。", 409);
    if (
      this.vault.db.prepare("SELECT id FROM jobs WHERE id=?").get(requestId)
    ) {
      const prior = this.get(requestId);
      const followUp = prior.snapshot.codexFollowUp;
      if (
        followUp?.proposalId !== proposalId ||
        followUp.draftHash !== expectedHash ||
        prior.snapshot.instruction !== feedback ||
        followUp?.mode !== review?.mode ||
        (followUp?.quote || "") !== (review?.quote || "") ||
        JSON.stringify(followUp?.comments) !==
          JSON.stringify(
            revisionComments(followUp?.base.markdown || "", review?.comments),
          ) ||
        (review?.codexOptions &&
          JSON.stringify(prior.snapshot.codexOptions) !==
            JSON.stringify(review.codexOptions))
      )
        throw new AppError("这次提交已用于另一条修改意见", 409);
      return prior;
    }
    this.assertIdle(proposalId);
    const proposal = this.getProposal(proposalId);
    const job = this.get(proposal.jobId);
    if (job.executor !== "codex-cli")
      throw new AppError("此草稿由其他方式生成，请在原对话中继续。", 409);
    this.assertCurrentDraft(proposal);
    if (
      proposal.status !== "pending" ||
      proposal.draftHash !== expectedHash ||
      proposal.recovery
    )
      throw new AppError(
        "请先核对并保存当前待审稿，再提交修改意见。",
        409,
        "VERSION_CONFLICT",
      );
    if (
      review?.quote &&
      !proposal.markdown
        .replace(/\r\n/g, "\n")
        .includes(review.quote.replace(/\r\n/g, "\n"))
    )
      throw new AppError(
        "引用的段落已变化，请在当前稿件中重新选取。",
        409,
        "VERSION_CONFLICT",
      );
    const comments = revisionComments(proposal.markdown, review?.comments);
    const rootJobId = codexRootJob(job);
    if (
      this.vault.db
        .prepare(
          "SELECT 1 FROM jobs WHERE state IN ('queued','running') AND (id=? OR json_extract(snapshot,'$.codexFollowUp.rootJobId')=?) LIMIT 1",
        )
        .get(rootJobId, rootJobId)
    )
      throw new AppError("同一条 Codex 对话正在处理，请等当前一轮结束。", 409);
    const {
      schema,
      id,
      createdAt,
      inputHash,
      instruction,
      codexFollowUp,
      ...inputs
    } = job.snapshot;
    const {
      title,
      action,
      targetPath,
      baseHash,
      noteType,
      markdown,
      sourceIds,
      unresolved,
      childNotes,
    } = proposal;
    const data = {
      ...inputs,
      ...(review?.codexOptions ? { codexOptions: review.codexOptions } : {}),
      instruction: feedback,
      codexFollowUp: {
        rootJobId,
        proposalId,
        draftHash: expectedHash,
        ...(review ? { mode: review.mode } : {}),
        ...(review?.quote ? { quote: review.quote } : {}),
        ...(comments ? { comments } : {}),
        base: {
          title,
          action,
          targetPath,
          // Acceptance of the new draft still checks the original note version.
          baseHash,
          noteType,
          markdown,
          sourceIds,
          unresolved,
          childNotes,
        },
      },
    };
    return this.persistBatch(
      { ...data, previewHash: digest(JSON.stringify(data)) },
      undefined,
      requestId,
    );
  }
  private persistBatch(
    { previewHash, ...data }: BatchPreview,
    expectedPreviewHash: string | undefined,
    id: string,
    selection?: unknown,
  ) {
    if (
      expectedPreviewHash !== undefined &&
      expectedPreviewHash !== previewHash
    )
      throw new AppError(
        "发送内容或运行设置在预览后已变化，请重新预览再确认",
        409,
        "PREVIEW_CHANGED",
      );
    const base = {
      schema: "batch-snapshot/v1" as const,
      id,
      createdAt: now(),
      ...data,
    };
    const snapshot: BatchSnapshot = {
      ...base,
      inputHash: digest(JSON.stringify(base)),
    };
    this.vault.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?)")
      .run(
        base.id,
        data.executor === "codex" ? "shared" : "queued",
        data.executor,
        base.createdAt,
        null,
        JSON.stringify(snapshot),
      );
    for (const source of data.codexFollowUp ? [] : data.sources)
      this.vault.db
        .prepare("INSERT INTO job_items VALUES(?,?,?,?,?)")
        .run(base.id, source.id, "pending", null, null);
    if (selection !== undefined)
      this.vault.db
        .prepare(
          "INSERT INTO settings VALUES('research-profile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(researchSelectionSchema.parse(selection)));
    return this.get(base.id);
  }
  get(id: string): Job {
    const r = this.vault.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(id) as any;
    if (!r) throw new AppError("任务不存在", 404);
    const snapshot: BatchSnapshot = JSON.parse(r.snapshot);
    const codexThreadId =
      r.executor === "codex-cli"
        ? this.codexThread(snapshot.codexFollowUp?.rootJobId || id)
        : undefined;
    if (
      snapshot.researchProfile !== undefined &&
      !researchSnapshotSchema.safeParse(snapshot.researchProfile).success
    )
      throw new AppError(
        "批次科研配置损坏或版本不受支持，已停止交付；请保留原批次并重新预览",
        409,
        "INVALID_RESEARCH_PROFILE",
      );
    return {
      id: r.id,
      state: r.state,
      executor: r.executor,
      createdAt: r.created_at,
      error: r.error,
      ...(codexThreadId ? { codexThreadId } : {}),
      snapshot,
      items: (
        this.vault.db
          .prepare("SELECT * FROM job_items WHERE job_id=?")
          .all(id) as any[]
      ).map((i) => ({
        sourceId: i.source_id,
        state: i.state,
        output: i.output,
        error: i.error,
      })),
    };
  }
  list() {
    return (
      this.vault.db
        .prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 100")
        .all() as any[]
    ).map((r) => this.get(r.id));
  }
  private codexThread(rootJobId: string) {
    return (
      this.vault.db
        .prepare("SELECT thread_id FROM codex_threads WHERE root_job_id=?")
        .get(rootJobId) as { thread_id: string } | undefined
    )?.thread_id;
  }
  private reviewProgress(jobId: string): ReviewTurnProgress | undefined {
    const row = this.vault.db
      .prepare("SELECT turn_id, text FROM codex_review_turns WHERE job_id=?")
      .get(jobId) as { turn_id: string | null; text: string } | undefined;
    return row && { turnId: row.turn_id || undefined, text: row.text };
  }
  private saveReviewProgress(jobId: string, progress: ReviewTurnProgress) {
    this.vault.db
      .prepare(
        "INSERT INTO codex_review_turns VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET turn_id=excluded.turn_id,text=excluded.text",
      )
      .run(jobId, progress.turnId || null, progress.text);
  }
  conversation(jobId: string, includeDrafts = true): CodexConversation {
    const requested = this.get(jobId);
    if (requested.executor !== "codex-cli")
      throw new AppError("这里只显示本机 Codex CLI 的对话", 404);
    const rootJobId = codexRootJob(requested);
    const root = this.get(rootJobId);
    const jobs = this.vault.db
      .prepare(
        "SELECT id FROM jobs WHERE id=? OR json_extract(snapshot,'$.codexFollowUp.rootJobId')=? ORDER BY rowid",
      )
      .all(rootJobId, rootJobId) as { id: string }[];
    const proposals = this.vault.db.prepare(
      "SELECT id, body FROM proposals WHERE job_id=? ORDER BY rowid",
    );
    return {
      rootJobId,
      threadId: root.codexThreadId,
      title:
        root.snapshot.noteRevision?.title ||
        root.snapshot.sources[0]?.ref.title ||
        "材料整理",
      turns: jobs.map(({ id }) => {
        const job = this.get(id);
        const followUp = job.snapshot.codexFollowUp;
        return {
          jobId: job.id,
          at: job.createdAt,
          instruction: job.snapshot.instruction,
          state: job.state,
          error: job.error,
          followUp: Boolean(followUp),
          mode: followUp?.mode,
          quote: followUp?.quote,
          comments: followUp?.comments,
          baseId: followUp?.proposalId,
          codexOptions: job.snapshot.codexOptions,
          answer:
            followUp?.mode === "chat"
              ? this.reviewProgress(id)?.text
              : undefined,
          replies: (
            proposals.all(job.id) as { id: string; body: string }[]
          ).map((p) => {
            const { title, markdown } = storedProposalSchema.parse(
              JSON.parse(p.body),
            );
            return { id: p.id, title, markdown: includeDrafts ? markdown : "" };
          }),
        };
      }),
    };
  }
  cancel(id: string) {
    const job = this.get(id);
    const active = this.running.get(id);
    active?.abort();
    if (job.snapshot.codexFollowUp?.mode && active) return job;
    this.vault.db
      .prepare(
        "UPDATE jobs SET state='paused',error='用户已暂停。已完成分项保留。' WHERE id=?",
      )
      .run(id);
    return this.get(id);
  }
  async run(id: string) {
    const job = this.get(id);
    if (job.executor === "codex")
      throw new AppError("此任务已交给 Codex，请在对话中继续");
    if (job.executor === "codex-cli" && !this.callLocalCodex)
      throw new AppError("请打开桌面知识工作台使用本机 Codex CLI", 409);
    if (this.running.has(id)) return this.get(id);
    if (["completed", "review"].includes(job.state)) return job;
    const followUp = job.snapshot.codexFollowUp;
    if (followUp && followUp.mode !== "chat") {
      const draft = this.getProposal(followUp.proposalId);
      const replacement =
        draft.supersededBy && this.getProposal(draft.supersededBy);
      if (
        draft.status !== "pending" ||
        draft.draftHash !== followUp.draftHash ||
        (replacement && replacement.jobId !== id)
      )
        throw new AppError(
          "这轮修改对应的待审稿已有变化，请从当前稿继续。",
          409,
          "VERSION_CONFLICT",
        );
    }
    if (
      job.executor === "codex-cli" &&
      [...this.running.keys()].some(
        (active) => codexRootJob(this.get(active)) === codexRootJob(job),
      )
    )
      throw new AppError("同一条 Codex 对话正在处理，请等当前一轮结束。", 409);
    const controller = new AbortController();
    this.running.set(id, controller);
    this.vault.db
      .prepare("UPDATE jobs SET state='running',error=NULL WHERE id=?")
      .run(id);
    void this.execute(job, controller).finally(() => this.running.delete(id));
    return this.get(id);
  }
  async execute(job: Job, controller: AbortController) {
    try {
      let provider: Provider | undefined;
      const rootJobId = codexRootJob(job);
      let threadId =
        job.executor === "codex-cli" ? this.codexThread(rootJobId) : undefined;
      const followUp = job.snapshot.codexFollowUp;
      const generate = async (prompt: string, images: ModelImages = []) => {
        controller.signal.throwIfAborted();
        if (job.executor === "codex-cli")
          return this.callLocalCodex!(
            prompt,
            images,
            controller.signal,
            job.snapshot.researchProfile,
            job.snapshot.codexOptions,
            {
              workspace: path.join(
                this.vault.dataDir,
                "codex-workspaces",
                rootJobId,
              ),
              threadId,
              ...(followUp?.mode
                ? {
                    live: {
                      requestId: job.id,
                      previous: this.reviewProgress(job.id),
                      onDispatch: () =>
                        this.saveReviewProgress(job.id, { text: "" }),
                      onProgress: (progress: ReviewTurnProgress) =>
                        this.saveReviewProgress(job.id, progress),
                    },
                  }
                : {}),
              onThread: (id) => {
                if (threadId && threadId !== id)
                  throw new AppError(
                    "Codex 返回了另一条会话，已保留任务供核对。",
                    409,
                  );
                this.vault.db
                  .prepare(
                    "INSERT OR IGNORE INTO codex_threads(root_job_id,thread_id) VALUES(?,?)",
                  )
                  .run(rootJobId, id);
                if (this.codexThread(rootJobId) !== id)
                  throw new AppError(
                    "Codex 会话记录已变化，请重新打开任务。",
                    409,
                  );
                threadId = id;
              },
            },
          );
        provider ||= await this.getProvider();
        return callProvider(
          provider,
          prompt,
          images,
          controller.signal,
          job.snapshot.researchProfile,
        );
      };
      for (const item of followUp ? [] : job.snapshot.sources) {
        if (controller.signal.aborted) throw new Error("已暂停");
        const cached = job.items.find((i) => i.sourceId === item.id);
        if (cached?.state === "done") continue;
        this.vault.db
          .prepare(
            "UPDATE job_items SET state='running',error=NULL WHERE job_id=? AND source_id=?",
          )
          .run(job.id, item.id);
        const images = item.ref.assetPath
          ? [
              {
                data: this.captures.image(item.ref).toString("base64"),
                mime: item.ref.mime!,
              },
            ]
          : [];
        const output = await generate(
          `逐项整理这份材料，分为【原文可见内容】【公式与符号】【用户想法】【AI 推断】【待核对】。保留实际页码，模糊内容标记，不补造。材料 ID：${item.id}\n来源：${JSON.stringify(item.ref)}\n记录：${item.text}`,
          images,
        );
        const extractionPath = `${this.vault.managed}/Drafts/Extraction-${job.id}-${item.id}.md`;
        atomicWrite(
          this.vault.absolute(extractionPath),
          formatMarkdown(
            {
              title: item.ref.title + " · AI 识读",
              note_type: "ai-extraction",
              status: "working",
              kb_extraction: {
                jobId: job.id,
                sourceId: item.id,
                sourceVersion: item.version,
              },
              source: [`[[${item.path}]]`],
            },
            output,
          ),
        );
        this.vault.index(extractionPath);
        this.vault.db
          .prepare(
            "UPDATE job_items SET state='done',output=?,error=NULL WHERE job_id=? AND source_id=?",
          )
          .run(output, job.id, item.id);
      }
      if (controller.signal.aborted) throw new Error("已暂停");
      const revision = job.snapshot.noteRevision;
      const imageOrder =
        revision?.images?.map(({ path, line }, index) => ({
          image: index + 1,
          path,
          noteLine: line,
        })) || [];
      const original =
        followUp && !threadId ? this.get(rootJobId).snapshot : undefined;
      const continuation = followUp
        ? [
            ...(followUp.mode === "chat"
              ? [
                  "这是待审稿的分析追问。用可阅读的 Markdown 直接回答问题。结合本会话已经确认的材料、下方稿件和所选段落。使用 $…$ 和 $$ 排版公式。",
                  "本轮问题：" + job.snapshot.instruction,
                ]
              : [
                  "根据用户最新的修改意见，接着修改当前待审稿。以消息中保存的最新版正文为编辑基准，并沿用本会话已经确认的证据、图片和任务范围。",
                  "保留标题、来源引用及经人工保留的内容。把能完成的修改直接写入正文。",
                  '仅返回 JSON {"markdown":"完整的新版正文","unresolved":[],"annotationResponses":[{"line":1,"state":"answered","response":"逐项答复"}],"childNotes":[{"key":"derivation","title":"详细推导","markdown":"子笔记完整正文"}]}。正文使用 [详细推导](child-note:derivation) 链接到对应子笔记。需补条件时使用 needs-context。没有列出的批注行使用空数组。',
                  "修改意见：" + job.snapshot.instruction,
                  ...(followUp.comments
                    ? [
                        "按顺序处理下面各条修改意见。每条引用和行号都对应当前待审稿中的位置。结合各自上下文落实修改，缺少引用的意见适用于全文。将所有修改合成一份完整新版。",
                        JSON.stringify(
                          followUp.comments.map(({ text, anchor }, index) => ({
                            序号: index + 1,
                            待审稿起始行: anchor?.line,
                            待审稿起始列: anchor?.column,
                            引用: anchor?.text,
                            意见: text,
                          })),
                        ),
                      ]
                    : []),
                ]),
            ...(followUp.quote
              ? ["本轮选中的段落：" + JSON.stringify(followUp.quote)]
              : []),
            "当前待审稿：" + JSON.stringify(followUp.base),
            "需要继续核对的批注行：" +
              JSON.stringify(revision?.annotations || []),
            ...(original
              ? [
                  "这是从已保存草稿开始的新会话。以下是原先确认的交接范围。",
                  "原任务要求：" + original.instruction,
                  "原笔记：" + JSON.stringify(original.noteRevision || null),
                  "已确认材料：" + JSON.stringify(original.sources),
                  "已确认参考笔记：" + JSON.stringify(original.references),
                  "随附图片编号：" + JSON.stringify(imageOrder),
                ]
              : []),
          ].join("\n")
        : undefined;
      const prompt =
        continuation ??
        (revision
          ? `按照当前任务目录 AGENTS.md 优化指定笔记。用户确认把目标笔记作者留下的原问题、批注、待办与下面的补充要求交给你。结合随附图片把能完成的答案、计算和推导写入对应正文。保留原标题、原有观察、图像引用、出处、公式和未决问题。\n仅返回 JSON {"markdown":"完整的优化后正文，不含 YAML 属性","unresolved":["需人工核对的问题"],"annotationResponses":[{"line":1,"state":"answered","response":"本条的实质答案，或能完成的部分及缺少的具体条件"}],"childNotes":[{"key":"derivation","title":"详细推导","markdown":"独立子笔记的完整正文"}]}。annotationResponses 的 line 必须与下面列出的作者批注逐一对应，每条只出现一次。需补条件时使用 needs-context。需要子笔记时，在 parent markdown 对应位置使用 [详细推导](child-note:derivation)，内容放入 childNotes。没有列出的其他作者批注也应在正文处理。\n用户补充要求：${job.snapshot.instruction || "按原笔记用途整理"}\n目标笔记：${JSON.stringify({ title: revision.title, content: revision.content })}\n作者批注（行号以发送的正文为准）：${JSON.stringify(revision.annotations || [])}\n随附图片（编号对应附件顺序）：${JSON.stringify(imageOrder)}\n未能随附的图片：${JSON.stringify(revision.imageIssues || [])}\n已确认参考笔记：${JSON.stringify(job.snapshot.references)}`
          : `把材料整理为少量主题知识卡与一篇学习记录。仅返回 JSON：{"drafts":[{"title":"标题","action":"create或amend","noteType":"concept或learning-log","markdown":"完整Markdown正文","sourceIds":["真实材料UUID"],"unresolved":["疑点"]}]}。amend 仅允许所提供参考笔记，必须附 targetPath 与 baseHash 原值；保留原有 YAML 属性、用户想法、来源及未解决问题。区分原始信息与推断，不声称已经验证。新稿用 create。每份至少一个真实来源。\n用户要求：${job.snapshot.instruction}\n逐项提取：${JSON.stringify(this.get(job.id).items)}\n材料来源：${JSON.stringify(job.snapshot.sources.map((s) => ({ id: s.id, ref: s.ref })))}\n参考笔记：${JSON.stringify(job.snapshot.references)}`);
      const loadImages = () =>
        revision?.images && (!followUp || !threadId)
          ? optimizationImages(this.vault, revision.images)
          : [];
      if (followUp?.mode === "chat") {
        const answer = await generate(prompt, loadImages());
        controller.signal.throwIfAborted();
        const turnId = this.reviewProgress(job.id)?.turnId;
        this.saveReviewProgress(job.id, { text: answer, turnId });
        this.vault.db
          .prepare("UPDATE jobs SET state='completed',error=NULL WHERE id=?")
          .run(job.id);
        return;
      }
      const responseFile = path.join(
        this.vault.dataDir,
        "responses",
        job.id + ".json",
      );
      const commitFile = path.join(
        this.vault.dataDir,
        "responses",
        job.id + ".commit.json",
      );
      const parse = (raw: string) => {
        const parsed = JSON.parse(
          raw
            .trim()
            .replace(/^```(?:json)?\s*/, "")
            .replace(/\s*```$/, ""),
        );
        if (revision || followUp) {
          const { markdown, unresolved, annotationResponses, childNotes } =
            noteRevisionResultSchema.parse(parsed);
          if (followUp)
            return [
              this.validateProposal(job, {
                ...followUp.base,
                markdown: addNoteDirectory(parseMarkdown(markdown).body),
                unresolved,
                ...(annotationResponses ? { annotationResponses } : {}),
                ...(childNotes ? { childNotes } : {}),
              }),
            ];
          return [
            this.validateProposal(job, {
              title: revision!.title.slice(0, 200),
              action: "amend",
              targetPath: revision!.path,
              baseHash: revision!.hash,
              noteType: revision!.noteType,
              markdown: addNoteDirectory(parseMarkdown(markdown).body),
              sourceIds: [],
              unresolved,
              ...(annotationResponses ? { annotationResponses } : {}),
              ...(childNotes ? { childNotes } : {}),
            }),
          ];
        }
        if (
          !Array.isArray(parsed.drafts) ||
          !parsed.drafts.length ||
          parsed.drafts.length > 20
        )
          throw new AppError("模型草稿数量无效", 502);
        return parsed.drafts.map((d: unknown) =>
          this.validateProposal(job, d),
        ) as DraftProposal[];
      };
      let checkpoint:
        | {
            inputHash: string;
            drafts: DraftProposal[];
            hash: string;
            committed: string[];
          }
        | undefined;
      if (fs.existsSync(commitFile)) {
        checkpoint = JSON.parse(readUtf8(commitFile));
        if (
          !checkpoint ||
          checkpoint.inputHash !== job.snapshot.inputHash ||
          checkpoint.hash !== digest(JSON.stringify(checkpoint.drafts))
        )
          throw new AppError("汇总恢复记录校验失败，已停止以保留原结果", 409);
        checkpoint.drafts.forEach((d) => this.validateProposal(job, d));
      } else {
        let drafts: DraftProposal[] | undefined;
        if (fs.existsSync(responseFile)) {
          const saved = JSON.parse(readUtf8(responseFile));
          if (saved.inputHash && saved.inputHash !== job.snapshot.inputHash)
            throw new AppError("汇总快照不匹配", 409);
          try {
            drafts = parse(saved.raw);
          } catch {
            /* Invalid model output may be regenerated before any commit. */
          }
        }
        if (!drafts) {
          if (
            this.vault.db
              .prepare("SELECT id FROM proposals WHERE job_id=?")
              .get(job.id)
          )
            throw new AppError(
              "已有草稿但汇总恢复记录不可用，请核对原结果；不会重新生成",
              409,
            );
          const raw = await generate(prompt, loadImages());
          atomicWrite(
            responseFile,
            JSON.stringify({
              raw,
              inputHash: job.snapshot.inputHash,
              savedAt: now(),
            }),
          );
          try {
            drafts = parse(raw);
          } catch (error) {
            if (
              error instanceof AppError &&
              error.code === "ANNOTATIONS_INCOMPLETE"
            )
              throw error;
            throw new AppError(
              "模型结果格式不正确，原始返回已保留，可重试汇总",
              502,
            );
          }
        }
        checkpoint = {
          inputHash: job.snapshot.inputHash,
          drafts,
          hash: digest(JSON.stringify(drafts)),
          committed: [],
        };
        atomicWrite(commitFile, JSON.stringify(checkpoint));
      }
      for (let index = 0; index < checkpoint.drafts.length; index++) {
        if (controller.signal.aborted) throw new Error("已暂停");
        const p = this.submit(
          job.id,
          `${job.id}:${job.executor}:${index}`,
          checkpoint.drafts[index],
          job.snapshot.inputHash,
        );
        checkpoint.committed[index] = p.id;
        atomicWrite(commitFile, JSON.stringify(checkpoint));
      }
      this.vault.db
        .prepare("UPDATE jobs SET state='review',error=NULL WHERE id=?")
        .run(job.id);
    } catch (error) {
      const message = controller.signal.aborted
        ? job.snapshot.codexFollowUp?.mode
          ? "本轮已暂停，已收到的内容保留。"
          : "已暂停，完成的分项可以继续使用。"
        : error instanceof Error
          ? error.message
          : "处理失败";
      this.vault.db
        .prepare("UPDATE jobs SET state=?,error=? WHERE id=?")
        .run(controller.signal.aborted ? "paused" : "failed", message, job.id);
      this.vault.db
        .prepare(
          "UPDATE job_items SET state='pending',error=? WHERE job_id=? AND state='running'",
        )
        .run(message, job.id);
    }
  }
  validateProposal(job: Job, input: unknown) {
    const revision = job.snapshot.noteRevision;
    if (revision) {
      const proposal = noteRevisionDraftSchema.parse(input);
      if (
        proposal.targetPath !== revision.path ||
        proposal.baseHash !==
          (job.snapshot.codexFollowUp?.base.baseHash || revision.hash)
      )
        throw new AppError("优化草稿与确认的目标笔记版本不一致", 409);
      if (!parseMarkdown(proposal.markdown).body.trim())
        throw new AppError("优化草稿缺少正文", 502);
      validateChildNotes(proposal.markdown, proposal.childNotes);
      if (revision.annotations?.length) {
        const required = new Set(revision.annotations.map((item) => item.line));
        const results = proposal.annotationResponses || [];
        if (
          results.length !== required.size ||
          results.some((item) => !required.delete(item.line))
        )
          throw new AppError(
            "Codex 的结果漏掉了部分批注回应。原始结果已保留，可重试。",
            502,
            "ANNOTATIONS_INCOMPLETE",
          );
      }
      return proposal;
    }
    const proposal = draftProposalSchema.parse(input);
    parseMarkdown(proposal.markdown);
    validateChildNotes(proposal.markdown, proposal.childNotes);
    if (
      proposal.sourceIds.some(
        (id) => !job.snapshot.sources.some((s) => s.id === id),
      )
    )
      throw new AppError("草稿包含本批之外的来源");
    if (proposal.action === "amend") {
      const base = job.snapshot.codexFollowUp?.base;
      const targets =
        base?.action === "amend"
          ? [{ path: base.targetPath, hash: base.baseHash }]
          : job.snapshot.references;
      if (
        !targets.some(
          (note) =>
            note.path === proposal.targetPath &&
            note.hash === proposal.baseHash,
        )
      )
        throw new AppError("修改目标或原版本不在已确认的交接范围内");
    }
    return proposal;
  }
  submit(jobId: string, requestId: string, input: unknown, inputHash: string) {
    const job = this.get(jobId);
    if (job.snapshot.inputHash !== inputHash)
      throw new AppError("批次快照版本不匹配", 409);
    if (!["shared", "running", "review", "failed"].includes(job.state))
      throw new AppError("任务未共享或已暂停，请在软件中继续后再提交", 409);
    const proposal = this.validateProposal(job, input),
      prior = this.vault.db
        .prepare("SELECT * FROM proposals WHERE request_id=?")
        .get(requestId) as any;
    if (prior) {
      if (
        prior.job_id !== jobId ||
        JSON.stringify(JSON.parse(prior.body)) !== JSON.stringify(proposal)
      )
        throw new AppError("请求标识已用于不同草稿", 409);
      return this.proposal(prior);
    }
    // Stable identity survives a process exit between the file write and SQLite insertion.
    const hex = digest(jobId + ":" + requestId),
      id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      relative = `${this.vault.managed}/Drafts/${slug(proposal.title)}--${id.slice(0, 8)}.md`;
    const submissionFile = path.join(
      this.vault.dataDir,
      "submissions",
      id + ".json",
    );
    const submission = { id, jobId, requestId, inputHash, proposal };
    if (fs.existsSync(submissionFile)) {
      if (readUtf8(submissionFile) !== JSON.stringify(submission))
        throw new AppError("请求标识已用于不同草稿", 409);
    } else atomicWrite(submissionFile, JSON.stringify(submission));
    const content = formatMarkdown(
      {
        title: proposal.title,
        note_type: proposal.noteType,
        status: "working",
        kb_id: id,
        kb_review_state: "pending",
        kb_proposal: {
          jobId,
          requestId,
          inputHash,
          ...proposal,
          markdown: undefined,
        },
        kb_source_paths: proposal.sourceIds.map(
          (id) => job.snapshot.sources.find((s) => s.id === id)!.path,
        ),
      },
      proposal.markdown,
    );
    if (fs.existsSync(this.vault.absolute(relative))) {
      if (readUtf8(this.vault.absolute(relative)) !== content)
        throw new AppError("已落盘草稿内容与恢复记录不同，请核对后继续", 409);
    } else atomicWrite(this.vault.absolute(relative), content, true);
    this.vault.db
      .prepare("INSERT INTO proposals VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        jobId,
        "pending",
        relative,
        JSON.stringify(proposal),
        requestId,
        null,
      );
    this.vault.db
      .prepare("UPDATE jobs SET state='review' WHERE id=? AND state!='running'")
      .run(jobId);
    this.vault.index(relative);
    return this.getProposal(id);
  }
  proposal(row: any): Proposal {
    const note = this.vault.read(row.path);
    const state = note.metadata.kb_review_state;
    const identity = note.metadata.kb_proposal as any;
    if (
      !["pending", "accepted", "rejected"].includes(String(state)) ||
      note.id !== row.id ||
      identity?.requestId !== row.request_id ||
      identity?.jobId !== row.job_id
    )
      throw new AppError("草稿身份或审核状态无效，请先修复 Markdown", 409);
    if (!this.accepting.has(row.id)) {
      // Markdown owns review decisions; SQLite only caches an observed version.
      if (digest(readUtf8(this.vault.absolute(row.path))) !== note.hash)
        throw new AppError(
          "草稿在读取期间改变，请重试",
          409,
          "VERSION_CONFLICT",
        );
      this.vault.db
        .prepare(
          "UPDATE proposals SET status=?,accepted_path=? WHERE id=? AND status=? AND body=?",
        )
        .run(
          String(state),
          note.metadata.kb_accepted_path
            ? String(note.metadata.kb_accepted_path)
            : null,
          row.id,
          row.status,
          row.body,
        );
    }
    const subsequent = state === "pending" ? this.revisionsAfter(row.id) : {};
    const stored = JSON.parse(row.body);
    const markdown = parseMarkdown(note.content).body;
    const converted =
      state === "pending" &&
      !stored.childNotes?.length &&
      markdown.includes("子笔记草稿")
        ? legacyChildNotes(markdown).children
        : [];
    return {
      ...stored,
      ...((note.metadata.kb_proposal as any)?.baseHash
        ? { baseHash: (note.metadata.kb_proposal as any).baseHash }
        : {}),
      markdown,
      ...(converted.length
        ? { childNotes: converted, legacyChildren: true }
        : {}),
      id: row.id,
      jobId: row.job_id,
      status: state as Proposal["status"],
      path: row.path,
      acceptedPath: note.metadata.kb_accepted_path
        ? String(note.metadata.kb_accepted_path)
        : undefined,
      draftHash: note.hash,
      ...subsequent,
      ...(note.draft
        ? { recovery: parseMarkdown(note.draft.content).body }
        : {}),
    };
  }
  private revisionsAfter(id: string): {
    supersededBy?: string;
    revising?: boolean;
  } {
    const next = this.vault.db
      .prepare(
        "SELECT p.id FROM proposals p JOIN jobs j ON p.job_id=j.id WHERE json_extract(j.snapshot,'$.codexFollowUp.proposalId')=? AND p.status<>'rejected' ORDER BY p.rowid DESC LIMIT 1",
      )
      .get(id) as { id: string } | undefined;
    const active = this.vault.db
      .prepare(
        "SELECT 1 FROM jobs WHERE json_extract(snapshot,'$.codexFollowUp.proposalId')=? AND COALESCE(json_extract(snapshot,'$.codexFollowUp.mode'),'revision')='revision' AND state IN ('queued','running') LIMIT 1",
      )
      .get(id);
    return {
      ...(next ? { supersededBy: next.id } : {}),
      ...(active ? { revising: true } : {}),
    };
  }
  private assertCurrentDraft(proposal: Proposal) {
    if (proposal.supersededBy)
      throw new AppError("已生成新版草稿，请在对话记录里对照旧稿。", 409);
    if (proposal.revising)
      throw new AppError("Codex 正在修改这份草稿，请等本轮完成。", 409);
  }
  getProposal(id: string) {
    const r = this.vault.db
      .prepare("SELECT * FROM proposals WHERE id=?")
      .get(id);
    if (!r) throw new AppError("草稿不存在", 404);
    return this.proposal(r);
  }
  proposals() {
    return (
      this.vault.db
        .prepare("SELECT * FROM proposals ORDER BY rowid DESC")
        .all() as any[]
    ).map((r) => {
      try {
        return this.proposal(r);
      } catch {
        return {
          ...JSON.parse(r.body),
          id: r.id,
          jobId: r.job_id,
          status: r.status,
          path: r.path,
          draftHash: "",
          unavailable: "草稿文件暂不可读，记录保留；请等待文件可用后再审核。",
          ...this.revisionsAfter(r.id),
        } as Proposal;
      }
    });
  }
  rebuildProposals() {
    for (const n of this.vault
      .list()
      .filter(
        (n) => !n.missing && n.path.startsWith(`${this.vault.managed}/Drafts/`),
      )) {
      try {
        const doc = this.vault.read(n.path),
          p = doc.metadata.kb_proposal as any;
        if (!p) continue;
        if (this.accepting.has(n.id)) continue;
        const parsed = storedProposalSchema.parse({
          ...p,
          markdown: parseMarkdown(doc.content).body,
        });
        const receipt = path.join(
          this.vault.dataDir,
          "submissions",
          n.id + ".json",
        );
        const submission = fs.existsSync(receipt)
          ? JSON.parse(readUtf8(receipt))
          : null;
        if (
          submission &&
          (submission.id !== n.id ||
            submission.jobId !== p.jobId ||
            submission.requestId !== p.requestId ||
            submission.inputHash !== p.inputHash)
        )
          throw new AppError("提交恢复记录与 Markdown 身份不匹配", 409);
        this.vault.db
          .prepare("INSERT OR IGNORE INTO proposals VALUES(?,?,?,?,?,?,?)")
          .run(
            n.id,
            p.jobId,
            String(doc.metadata.kb_review_state || "pending"),
            n.path,
            JSON.stringify(
              submission
                ? storedProposalSchema.parse(submission.proposal)
                : parsed,
            ),
            p.requestId,
            doc.metadata.kb_accepted_path
              ? String(doc.metadata.kb_accepted_path)
              : null,
          );
        const row = this.vault.db
          .prepare("SELECT * FROM proposals WHERE id=?")
          .get(n.id);
        if (row) this.proposal(row);
      } catch {
        this.vault.warnings.push(`审核稿协调失败，原任务状态保留：${n.path}`);
      }
    }
  }
  edit(id: string, markdown: string, expectedHash: string) {
    this.assertIdle(id);
    parseMarkdown(markdown);
    const p = this.getProposal(id);
    this.assertCurrentDraft(p);
    if (p.status !== "pending") throw new AppError("此草稿已审核", 409);
    const note = this.vault.read(p.path),
      parsed = parseMarkdown(note.content);
    this.vault.save(
      p.path,
      formatMarkdown(parsed.metadata, markdown),
      expectedHash,
    );
    return this.getProposal(id);
  }
  async accept(
    id: string,
    markdown: string,
    saveManaged: (
      path: string,
      text: string,
      hash: string,
    ) => Promise<NoteLike>,
    expectedDraftHash?: string,
  ) {
    this.assertIdle(id);
    // Synchronize a fresh file version before reserving the asynchronous acceptance.
    this.assertCurrentDraft(this.getProposal(id));
    this.accepting.add(id);
    try {
      return await this.acceptReserved(
        id,
        markdown,
        saveManaged,
        expectedDraftHash,
      );
    } finally {
      this.accepting.delete(id);
    }
  }
  assertIdle(id: string) {
    if (this.accepting.has(id))
      throw new AppError(
        "此草稿正在接受，请等待当前保存完成",
        409,
        "ACCEPT_IN_PROGRESS",
      );
  }
  async acceptReserved(
    id: string,
    markdown: string,
    saveManaged: (
      path: string,
      text: string,
      hash: string,
    ) => Promise<NoteLike>,
    expectedDraftHash?: string,
  ) {
    const p = this.getProposal(id);
    if (p.status === "accepted") return { path: p.acceptedPath };
    if (p.status !== "pending") throw new AppError("草稿已经退回", 409);
    if (!markdown.trim() || markdown.length > 500000)
      throw new AppError("草稿正文为空或过长");
    const draft = this.vault.read(p.path),
      parsed = parseMarkdown(draft.content);
    if (expectedDraftHash && draft.hash !== expectedDraftHash)
      throw new AppError(
        "草稿在其他窗口中发生修改，请重新打开并核对。",
        409,
        "VERSION_CONFLICT",
      );
    let edited = parseMarkdown(markdown);
    const batch = this.get(p.jobId).snapshot;
    const revision = batch.noteRevision;
    if (
      revision &&
      (p.action !== "amend" ||
        p.targetPath !== revision.path ||
        p.sourceIds.length)
    )
      throw new AppError("优化草稿与确认的目标笔记不一致", 409);
    const snapshots = batch.sources.filter((s) => p.sourceIds.includes(s.id));
    if (snapshots.length !== new Set(p.sourceIds).size)
      throw new AppError("来源不在原始批次内", 409, "SOURCE_UNAVAILABLE");
    let sources: string[] = [];
    if (!revision) {
      if (!snapshots.length)
        throw new AppError("缺少原始材料快照", 409, "SOURCE_UNAVAILABLE");
      this.vault.scan();
      if (this.vault.warnings.length)
        throw new AppError(
          "来源索引尚未完整读取，请等待文件可用后重试",
          409,
          "SOURCE_UNAVAILABLE",
        );
      const candidates = this.vault
        .list()
        .filter((n) => !n.missing)
        .map((n) => this.vault.read(n.path));
      sources = snapshots.map((s) => {
        const matches = candidates.filter(
          (n) => (n.metadata.kb_source as any)?.id === s.id,
        );
        if (matches.length !== 1)
          throw new AppError(
            `来源 ${s.ref.title} ${matches.length ? "身份存在歧义" : "暂不可用"}；请修复后重试`,
            409,
            "SOURCE_UNAVAILABLE",
          );
        return matches[0].path;
      });
    }
    const receipt = path.join(
      this.vault.dataDir,
      "acceptances",
      p.id + ".json",
    );
    let intent: any = fs.existsSync(receipt)
      ? JSON.parse(readUtf8(receipt))
      : null;
    const target =
      p.action === "amend"
        ? p.targetPath!
        : `${this.vault.managed}/${p.noteType === "learning-log" ? "Journal" : "Cards"}/${slug(p.title)}--${p.id}.md`;
    const current = fs.existsSync(this.vault.absolute(target))
      ? this.vault.read(target)
      : null;
    const currentText =
      current?.owner === "paperdesk" ? current.body : current?.content;
    if (revision && current?.owner === "paperdesk")
      throw new AppError("请在纸间管理文献笔记", 409, "PAPERDESK_REQUIRED");
    // Do not record an acceptance intent before the target passes its version check.
    if (
      p.action === "amend" &&
      current?.hash !== p.baseHash &&
      !(intent && currentText === intent.final)
    )
      throw new AppError(
        "目标笔记已有新版本，请对照差异后重新确认修订基准。",
        409,
        "VERSION_CONFLICT",
      );
    if (
      intent &&
      intent.markdown !== markdown &&
      !intent.children?.some((child: { path: string }) =>
        fs.existsSync(this.vault.absolute(child.path)),
      ) &&
      ((!current && p.action === "create") || current?.hash === p.baseHash)
    ) {
      atomicWrite(
        receipt + ".superseded-" + Date.now() + ".json",
        JSON.stringify(intent),
      );
      intent = null;
    }
    const recovering = Boolean(intent);
    if (intent && intent.markdown !== markdown)
      throw new AppError(
        "上次保存已开始，请先用上次审核内容完成恢复，再编辑正式笔记。",
        409,
        "ACCEPT_IN_PROGRESS",
      );
    const children = !intent
      ? prepareChildNotes(
          this.vault,
          p.id,
          target,
          markdown,
          p.childNotes,
          p.legacyChildren,
        )
      : undefined;
    const effectiveMarkdown = children
      ? revision
        ? addNoteDirectory(children.markdown)
        : children.markdown
      : markdown;
    if (effectiveMarkdown !== markdown)
      edited = parseMarkdown(effectiveMarkdown);
    let final = effectiveMarkdown;
    if (p.action === "create") {
      const doc = edited;
      final = formatMarkdown(
        {
          ...doc.metadata,
          title: p.title,
          note_type: p.noteType,
          domain: doc.metadata.domain || "shared",
          status: "working",
          source: sources.map((s) => `[[${s}]]`),
          tags: doc.metadata.tags || [],
          kb_id: p.id,
          kb_reviewed_at: now(),
          kb_proposal_id: p.id,
          kb_unresolved: p.unresolved,
          kb_source_snapshots: snapshots.map(
            ({ id, path, version, ref, text }) => ({
              id,
              path,
              version,
              ref,
              text,
            }),
          ),
        },
        doc.body +
          `\n\n## 材料来源\n\n${sources.map((s) => `- [[${s}]]`).join("\n")}\n`,
      );
    }
    if (revision) {
      if (!edited.body.trim()) throw new AppError("优化草稿缺少正文");
      const original = current!.content;
      const { frontmatter } = parseMarkdown(original);
      const newline = original.includes("\r\n") ? "\r\n" : "\n";
      const header =
        frontmatter || (original.startsWith("\uFEFF") ? "\uFEFF" : "");
      const separator =
        frontmatter && !frontmatter.endsWith("\n") ? newline : "";
      final =
        header +
        separator +
        edited.body.replace(/^\uFEFF/, "").replace(/\r?\n/g, newline);
      if (
        current?.draft &&
        current.draft.content !== original &&
        current.draft.content !== intent?.final
      )
        throw new AppError("请先处理目标笔记的未保存草稿", 409);
    } else if (p.action === "amend" && current?.owner !== "paperdesk") {
      const doc = edited,
        original = current!.metadata;
      const values = (v: unknown): unknown[] =>
        v === undefined ? [] : Array.isArray(v) ? v : [v];
      final = formatMarkdown(
        {
          ...doc.metadata,
          ...original,
          kb_id: current!.id,
          status: "working",
          source: [
            ...new Set([
              ...values(original.source),
              ...sources.map((s) => `[[${s}]]`),
            ]),
          ],
          kb_unresolved: [
            ...new Set([...values(original.kb_unresolved), ...p.unresolved]),
          ],
          kb_source_snapshots: [
            ...values(original.kb_source_snapshots),
            ...snapshots.map(({ id, path, version, ref, text }) => ({
              id,
              path,
              version,
              ref,
              text,
            })),
          ],
          kb_proposal_id: p.id,
          kb_reviewed_at: now(),
        },
        doc.body,
      );
    }
    if (!intent) {
      intent = {
        target,
        markdown,
        final,
        children: children?.children,
        baseHash: p.baseHash,
        createdAt: now(),
      };
      atomicWrite(receipt, JSON.stringify(intent));
    }
    const childFiles: { path: string; content: string }[] =
      intent.children || [];
    for (const child of childFiles) {
      const file = this.vault.absolute(child.path);
      if (fs.existsSync(file) && readUtf8(file) !== child.content)
        throw new AppError("子笔记位置已被占用，请保留恢复记录并核对。", 409);
    }
    const created: typeof childFiles = [];
    let note: NoteLike;
    try {
      for (const child of childFiles) {
        const file = this.vault.absolute(child.path);
        if (fs.existsSync(file)) continue;
        atomicWrite(file, child.content, true);
        created.push(child);
      }
      if (fs.existsSync(this.vault.absolute(target))) {
        const current = this.vault.read(target),
          currentText =
            current.owner === "paperdesk" ? current.body : current.content;
        if (recovering && currentText === intent.final) note = current;
        else if (p.action === "amend")
          note = await saveManaged(target, intent.final, p.baseHash!);
        else
          throw new AppError(
            "目标位置已有不同内容，请核对恢复记录",
            409,
            "VERSION_CONFLICT",
          );
      } else if (p.action === "create") {
        atomicWrite(this.vault.absolute(target), intent.final, true);
        note = this.vault.index(target);
      } else throw new AppError("目标笔记暂不可读，草稿已保留", 409);
    } catch (error) {
      // Clean up only this attempt's unchanged outputs if the parent did not
      // commit. A durable receipt keeps all other partial cases recoverable.
      try {
        const file = this.vault.absolute(target);
        const parentUnchanged = current
          ? this.vault.read(target).hash === current.hash &&
            currentText !== intent.final
          : !fs.existsSync(file);
        if (parentUnchanged)
          for (const child of created) {
            const childFile = this.vault.absolute(child.path);
            if (readUtf8(childFile) === child.content) fs.unlinkSync(childFile);
          }
      } catch {
        /* Do not remove files whose version or ownership cannot be verified. */
      }
      throw error;
    }
    for (const child of childFiles) this.vault.index(child.path);
    this.vault.save(
      p.path,
      formatMarkdown(
        {
          ...parsed.metadata,
          kb_review_state: "accepted",
          kb_accepted_path: note.path,
        },
        markdown,
      ),
      draft.hash,
    );
    this.vault.db
      .prepare(
        "UPDATE proposals SET status='accepted',accepted_path=? WHERE id=?",
      )
      .run(note.path, id);
    atomicWrite(
      receipt,
      JSON.stringify({ ...intent, state: "completed", completedAt: now() }),
    );
    if (
      !this.vault.db
        .prepare("SELECT id FROM proposals WHERE job_id=? AND status='pending'")
        .get(p.jobId)
    )
      this.vault.db
        .prepare("UPDATE jobs SET state='completed' WHERE id=?")
        .run(p.jobId);
    return note;
  }
  rebase(id: string, expectedDraftHash: string, targetHash: string) {
    this.assertIdle(id);
    const p = this.getProposal(id);
    this.assertCurrentDraft(p);
    if (p.status !== "pending" || p.action !== "amend")
      throw new AppError("只有待审修订稿可以更新基准", 409);
    const target = this.vault.read(p.targetPath!);
    if (target.hash !== targetHash)
      throw new AppError(
        "目标笔记再次改变，请重新查看差异。",
        409,
        "VERSION_CONFLICT",
      );
    const draft = this.vault.read(p.path),
      parsed = parseMarkdown(draft.content),
      proposal = parsed.metadata.kb_proposal as any;
    const receipt = path.join(
      this.vault.dataDir,
      "acceptances",
      p.id + ".json",
    );
    if (fs.existsSync(receipt)) {
      const intent = JSON.parse(readUtf8(receipt)),
        text = target.owner === "paperdesk" ? target.body : target.content;
      if (text === intent.final)
        throw new AppError("上次接受已写入正文，请先完成该次恢复。", 409);
      fs.renameSync(receipt, receipt + ".rebased-" + Date.now());
    }
    this.vault.save(
      p.path,
      formatMarkdown(
        {
          ...parsed.metadata,
          kb_rebased_at: now(),
          kb_rebased_from: p.baseHash,
          kb_proposal: { ...proposal, baseHash: targetHash },
        },
        parsed.body,
      ),
      expectedDraftHash,
    );
    return this.getProposal(id);
  }
  reject(id: string) {
    this.assertIdle(id);
    const p = this.getProposal(id);
    this.assertCurrentDraft(p);
    if (p.status !== "pending") return p;
    const draft = this.vault.read(p.path),
      parsed = parseMarkdown(draft.content);
    this.vault.save(
      p.path,
      formatMarkdown(
        { ...parsed.metadata, kb_review_state: "rejected" },
        parsed.body,
      ),
      draft.hash,
    );
    this.vault.db
      .prepare("UPDATE proposals SET status='rejected' WHERE id=?")
      .run(id);
    return this.getProposal(id);
  }
}
type NoteLike = { path: string; hash?: string };
