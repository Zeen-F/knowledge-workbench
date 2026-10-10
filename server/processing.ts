import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MANAGED,
  draftProposalSchema,
  type BatchSnapshot,
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

export class Processing {
  running = new Map<string, AbortController>();
  constructor(
    public vault: Vault,
    public captures: Captures,
    public getProvider: () => Promise<Provider>,
  ) {}
  create(
    sourceIds: string[],
    referencePaths: string[],
    executor: "api" | "codex",
    instruction: string,
  ) {
    if (!sourceIds.length || sourceIds.length > 100)
      throw new AppError("每批请选择 1 至 100 项材料");
    if (referencePaths.length > 20)
      throw new AppError("每批最多选择 20 篇参考笔记");
    const sources = [...new Set(sourceIds)].map((id) =>
      this.captures.snapshot(id),
    );
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
    const base = {
      schema: "batch-snapshot/v1" as const,
      id: randomUUID(),
      createdAt: now(),
      executor,
      instruction,
      sources,
      references,
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
    for (const source of sources)
      this.vault.db
        .prepare("INSERT INTO job_items VALUES(?,?,?,?,?)")
        .run(base.id, source.id, "pending", null, null);
    return this.get(base.id);
  }
  get(id: string): Job {
    const r = this.vault.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(id) as any;
    if (!r) throw new AppError("任务不存在", 404);
    return {
      id: r.id,
      state: r.state,
      executor: r.executor,
      createdAt: r.created_at,
      error: r.error,
      snapshot: JSON.parse(r.snapshot),
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
    const provider = await this.getProvider(),
      controller = new AbortController();
    this.running.set(id, controller);
    this.vault.db
      .prepare("UPDATE jobs SET state='running',error=NULL WHERE id=?")
      .run(id);
    void this.execute(job, provider, controller).finally(() =>
      this.running.delete(id),
    );
    return this.get(id);
  }
  async execute(job: Job, provider: Provider, controller: AbortController) {
    try {
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
          provider,
          `逐项整理这份材料，分为【原文可见内容】【公式与符号】【用户想法】【AI 推断】【待核对】。保留实际页码，模糊内容标记，不补造。材料 ID：${item.id}\n来源：${JSON.stringify(item.ref)}\n记录：${item.text}`,
          images,
          controller.signal,
        );
        const extractionPath = `${MANAGED}/Drafts/Extraction-${job.id}-${item.id}.md`;
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
      const raw = await callProvider(provider, prompt, [], controller.signal);
      atomicWrite(
        this.vault.dataDir + `/responses/${job.id}.json`,
        JSON.stringify({ raw, savedAt: now() }),
      );
      let parsed: any;
      try {
        parsed = JSON.parse(
          raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
        );
      } catch {
        throw new AppError(
          "模型结果格式不正确，原始返回已保留，可重试汇总",
          502,
        );
      }
      if (
        !Array.isArray(parsed.drafts) ||
        !parsed.drafts.length ||
        parsed.drafts.length > 20
      )
        throw new AppError("模型草稿数量无效", 502);
      const drafts = parsed.drafts.map((d: unknown) =>
        this.validateProposal(job, d),
      );
      for (let index = 0; index < drafts.length; index++)
        this.submit(
          job.id,
          `${job.id}:api:${index}`,
          drafts[index],
          job.snapshot.inputHash,
        );
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
    const id = randomUUID(),
      relative = `${MANAGED}/Drafts/${slug(proposal.title)}--${id.slice(0, 8)}.md`;
    atomicWrite(
      this.vault.absolute(relative),
      formatMarkdown(
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
      ),
      true,
    );
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
      .prepare("UPDATE jobs SET state='review' WHERE id=?")
      .run(jobId);
    this.vault.index(relative);
    return this.getProposal(id);
  }
  proposal(row: any): Proposal {
    const note = this.vault.read(row.path);
    return {
      ...JSON.parse(row.body),
      ...((note.metadata.kb_proposal as any)?.baseHash
        ? { baseHash: (note.metadata.kb_proposal as any).baseHash }
        : {}),
      markdown: parseMarkdown(note.content).body,
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      path: row.path,
      acceptedPath: row.accepted_path,
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
      .filter((n) => n.path.startsWith(`${MANAGED}/Drafts/`))) {
      try {
        const doc = this.vault.read(n.path),
          p = doc.metadata.kb_proposal as any;
        if (!p) continue;
        const parsed = draftProposalSchema.parse({
          ...p,
          markdown: parseMarkdown(doc.content).body,
        });
        this.vault.db
          .prepare("INSERT OR IGNORE INTO proposals VALUES(?,?,?,?,?,?,?)")
          .run(
            n.id,
            p.jobId,
            String(doc.metadata.kb_review_state || "pending"),
            n.path,
            JSON.stringify(parsed),
            p.requestId,
            doc.metadata.kb_accepted_path
              ? String(doc.metadata.kb_accepted_path)
              : null,
          );
      } catch {}
    }
  }
  edit(id: string, markdown: string, expectedHash: string) {
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
    const sources = Array.isArray(parsed.metadata.kb_source_paths)
      ? parsed.metadata.kb_source_paths.map(String)
      : this.get(p.jobId)
          .snapshot.sources.filter((s) => p.sourceIds.includes(s.id))
          .map((s) => s.path);
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
        : `${MANAGED}/${p.noteType === "learning-log" ? "Journal" : "Cards"}/${slug(p.title)}--${p.id}.md`;
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
        },
        doc.body +
          `\n\n## 材料来源\n\n${sources.map((s) => `- [[${s}]]`).join("\n")}\n`,
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
