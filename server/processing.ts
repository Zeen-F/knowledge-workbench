import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  draftProposalSchema,
  type BatchSnapshot,
  type BatchPreview,
  type DraftProposal,
  type Job,
  type Proposal,
  type Provider,
} from "../shared/contracts.ts";
import { AppError, atomicWrite, digest, now, readUtf8, slug } from "./files.ts";
import { formatMarkdown, parseMarkdown } from "./markdown.ts";
import { callProvider } from "./provider.ts";
import type { Vault } from "./vault.ts";
import type { Captures } from "./capture.ts";
import {
  GENERAL_PROFILE,
  researchSelectionSchema,
  researchSnapshotSchema,
  snapshotResearchProfile,
} from "../shared/research-profiles.ts";

export class Processing {
  running = new Map<string, AbortController>();
  accepting = new Set<string>();
  constructor(
    public vault: Vault,
    public captures: Captures,
    public getProvider: () => Promise<Provider>,
  ) {}
  preview(
    sourceIds: string[],
    referencePaths: string[],
    executor: "api" | "codex",
    instruction: string,
    selection: unknown = GENERAL_PROFILE,
  ): BatchPreview {
    if (!sourceIds.length || sourceIds.length > 100)
      throw new AppError("每批请选择 1 至 100 项材料");
    if (referencePaths.length > 20)
      throw new AppError("每批最多选择 20 篇参考笔记");
    const sources = [...new Set(sourceIds)].map((id) =>
      this.captures.snapshot(id),
    );
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
      executor,
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
    executor: "api" | "codex",
    instruction: string,
    selection: unknown = GENERAL_PROFILE,
    expectedPreviewHash?: string,
  ) {
    const { previewHash, ...data } = this.preview(
      sourceIds,
      referencePaths,
      executor,
      instruction,
      selection,
    );
    if (
      expectedPreviewHash !== undefined &&
      expectedPreviewHash !== previewHash
    )
      throw new AppError(
        "材料、参考笔记或科研配置在预览后已变化，请重新预览再确认",
        409,
        "PREVIEW_CHANGED",
      );
    const base = {
      schema: "batch-snapshot/v1" as const,
      id: randomUUID(),
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
        executor === "codex" ? "shared" : "queued",
        executor,
        base.createdAt,
        null,
        JSON.stringify(snapshot),
      );
    for (const source of data.sources)
      this.vault.db
        .prepare("INSERT INTO job_items VALUES(?,?,?,?,?)")
        .run(base.id, source.id, "pending", null, null);
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
  cancel(id: string) {
    this.get(id);
    this.running.get(id)?.abort();
    this.vault.db
      .prepare(
        "UPDATE jobs SET state='paused',error='用户已暂停。已完成分项保留。' WHERE id=?",
      )
      .run(id);
    return this.get(id);
  }
  async run(id: string) {
    const job = this.get(id);
    if (job.executor !== "api")
      throw new AppError("此任务已交给 Codex，请在对话中继续");
    if (this.running.has(id)) return this.get(id);
    if (["completed", "review"].includes(job.state)) return job;
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
      const configured = async () => {
        provider ||= await this.getProvider();
        if (controller.signal.aborted) throw new Error("已暂停");
        return provider;
      };
      for (const item of job.snapshot.sources) {
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
        const output = await callProvider(
          await configured(),
          `逐项整理这份材料，分为【原文可见内容】【公式与符号】【用户想法】【AI 推断】【待核对】。保留实际页码，模糊内容标记，不补造。材料 ID：${item.id}\n来源：${JSON.stringify(item.ref)}\n记录：${item.text}`,
          images,
          controller.signal,
          job.snapshot.researchProfile,
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
      const done = this.get(job.id);
      const prompt = `把材料整理为少量主题知识卡与一篇学习记录。仅返回 JSON：{"drafts":[{"title":"标题","action":"create或amend","noteType":"concept或learning-log","markdown":"完整Markdown正文","sourceIds":["真实材料UUID"],"unresolved":["疑点"]}]}。amend 仅允许所提供参考笔记，必须附 targetPath 与 baseHash 原值；保留原有 YAML 属性、用户想法、来源及未解决问题。区分原始信息与推断，不声称已经验证。新稿用 create。每份至少一个真实来源。\n用户要求：${job.snapshot.instruction}\n逐项提取：${JSON.stringify(done.items)}\n材料来源：${JSON.stringify(job.snapshot.sources.map((s) => ({ id: s.id, ref: s.ref })))}\n参考笔记：${JSON.stringify(job.snapshot.references)}`;
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
          raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
        );
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
          const raw = await callProvider(
            await configured(),
            prompt,
            [],
            controller.signal,
            job.snapshot.researchProfile,
          );
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
          } catch {
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
          `${job.id}:api:${index}`,
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
        ? "已暂停，完成的分项可以继续使用。"
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
    const proposal = draftProposalSchema.parse(input);
    parseMarkdown(proposal.markdown);
    if (
      proposal.sourceIds.some(
        (id) => !job.snapshot.sources.some((s) => s.id === id),
      )
    )
      throw new AppError("草稿包含本批之外的来源");
    if (
      proposal.action === "amend" &&
      !job.snapshot.references.some(
        (n) => n.path === proposal.targetPath && n.hash === proposal.baseHash,
      )
    )
      throw new AppError("修改目标或原版本不在已选参考笔记中");
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
    return {
      ...JSON.parse(row.body),
      ...((note.metadata.kb_proposal as any)?.baseHash
        ? { baseHash: (note.metadata.kb_proposal as any).baseHash }
        : {}),
      markdown: parseMarkdown(note.content).body,
      id: row.id,
      jobId: row.job_id,
      status: state as Proposal["status"],
      path: row.path,
      acceptedPath: note.metadata.kb_accepted_path
        ? String(note.metadata.kb_accepted_path)
        : undefined,
      draftHash: note.hash,
      ...(note.draft
        ? { recovery: parseMarkdown(note.draft.content).body }
        : {}),
    };
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
        const parsed = draftProposalSchema.parse({
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
                ? draftProposalSchema.parse(submission.proposal)
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
    this.getProposal(id);
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
    parseMarkdown(markdown);
    const snapshots = this.get(p.jobId).snapshot.sources.filter((s) =>
      p.sourceIds.includes(s.id),
    );
    if (snapshots.length !== new Set(p.sourceIds).size)
      throw new AppError("来源不在原始批次内", 409, "SOURCE_UNAVAILABLE");
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
    const sources = snapshots.map((s) => {
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
    let final = markdown;
    if (p.action === "create") {
      const doc = parseMarkdown(markdown);
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
    if (p.action === "amend" && current?.owner !== "paperdesk") {
      const doc = parseMarkdown(markdown),
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
        baseHash: p.baseHash,
        createdAt: now(),
      };
      atomicWrite(receipt, JSON.stringify(intent));
    }
    let note: NoteLike;
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
