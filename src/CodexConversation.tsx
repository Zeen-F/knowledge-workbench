import { useEffect, useId, useRef, useState } from "react";
import {
  ChevronRight,
  MessageSquare,
  Send,
  Sparkles,
  Square,
  UserRound,
  X,
} from "lucide-react";
import {
  codexRootJob,
  maxRevisionComments,
  type CodexReviewAnchor,
  type CodexConversation as Conversation,
  type CodexReviewInput,
  type Job,
} from "../shared/contracts";
import type { CodexCatalog, CodexOptions } from "../shared/codex-options";
import { api, prettyState, shortDate } from "./client";
import { SnapshotText } from "./MaterialContent";
import { CodexOptionsFields, CodexOptionsSummary } from "./CodexOptions";
import { ReviewDivider } from "./ReviewDivider";
import {
  type ReviewFeedback,
  commentsToSubmit,
  emptyReviewFeedback,
  clearCurrentOpinion,
  enqueueOpinion,
} from "./review-feedback";

export type ReviewMessage = {
  feedback: string;
  requestId: string;
  review: CodexReviewInput;
};

type ReviewPane = {
  proposalId: string;
  feedback: ReviewFeedback;
  onFeedback: (value: ReviewFeedback) => void;
  baseChanged: boolean;
  onCompareOriginal: () => void;
  describeDraft: (id: string) => string | undefined;
  onOpenDraft: (id: string) => void;
  onSend: (message: ReviewMessage) => Promise<void>;
  onClose: () => void;
  options: CodexOptions;
  catalog?: CodexCatalog;
  connection: {
    ready: boolean;
    checking: boolean;
    label: string;
    recheck: () => void;
  };
  disabled: boolean;
  path: string;
};

function jobTitle(job: Job) {
  return (
    job.snapshot.noteRevision?.title ||
    job.snapshot.codexFollowUp?.base.title ||
    job.snapshot.sources[0]?.ref.title ||
    "材料整理"
  );
}

const isActive = (state: string) => state === "queued" || state === "running";
const quoteLocation = ({ line, column }: CodexReviewAnchor) =>
  "第 " + line + " 行" + (column ? "第 " + column + " 列" : "");

export function CodexConversation({
  jobs,
  initialJobId,
  review,
  refresh,
}: {
  jobs: Job[];
  initialJobId?: string;
  review?: ReviewPane;
  refresh: () => Promise<unknown>;
}) {
  const available = [
    ...new Map(
      jobs
        .filter((job) => job.executor === "codex-cli")
        .map((job) => [codexRootJob(job), job] as const)
        .reverse(),
    ),
  ].reverse();
  const [selected, setSelected] = useState(available[0]?.[0] || "");
  const jobId = initialJobId || selected;
  const selectedJob = jobs.find((job) => job.id === jobId);
  const root = selectedJob ? codexRootJob(selectedJob) : jobId;
  const [history, setHistory] = useState<Conversation>();
  const [picked, setPicked] = useState<CodexOptions>();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const composerId = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerContext = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const refreshCurrent = useRef(refresh);
  refreshCurrent.current = refresh;
  const inline = Boolean(review);
  const timeline = JSON.stringify(
    jobs
      .filter((job) => codexRootJob(job) === root)
      .map((job) => [job.id, job.state, job.error]),
  );
  useEffect(() => {
    if (!root) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    let wasActive = false;
    async function load() {
      try {
        const result = await api<Conversation>(
          "GET",
          "/codex/conversation?jobId=" +
            encodeURIComponent(root) +
            (inline ? "&brief=1" : ""),
        );
        if (!current) return;
        setHistory(result);
        setLoadError("");
        const active = result.turns.some((turn) => isActive(turn.state));
        if (active) timer = setTimeout(load, 400);
        else if (wasActive) void refreshCurrent.current().catch(() => {});
        wasActive = active;
      } catch (e) {
        if (!current) return;
        setLoadError((e as Error).message);
        if (wasActive) timer = setTimeout(load, 1400);
      }
    }
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [root, timeline, inline, reload]);

  useEffect(() => {
    const area = messages.current;
    if (area && stickToBottom.current) area.scrollTop = area.scrollHeight;
  }, [history]);
  useEffect(() => {
    const area = messages.current;
    if (!area) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) area.scrollTop = area.scrollHeight;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const feedback = review?.feedback ?? emptyReviewFeedback;
  const anchor = feedback.anchor;
  useEffect(() => {
    if (!anchor) return;
    composer.current?.focus({ preventScroll: true });
    const context = composerContext.current;
    if (context) context.scrollTop = context.scrollHeight;
  }, [anchor]);

  const turns = history?.rootJobId === root ? history?.turns : undefined;
  const active = turns?.findLast((turn) => isActive(turn.state));
  const options = picked ?? review?.options;
  const canSend = Boolean(
    turns && review?.connection.ready && !review.disabled && !busy && !active,
  );
  const hasDiscussion = turns?.some(
    (turn) =>
      turn.mode === "chat" &&
      turn.state === "completed" &&
      turn.baseId === review?.proposalId,
  );
  const currentText = feedback.instruction.trim();
  const submittedComments = commentsToSubmit(feedback);
  const commentCount = submittedComments.length;
  const canRevise =
    canSend &&
    commentCount <= maxRevisionComments &&
    Boolean(commentCount || hasDiscussion);
  const canEdit = Boolean(review && !busy && !review.disabled);
  const canAdd =
    canEdit && Boolean(currentText) && commentCount <= maxRevisionComments;
  const draftLabel = review?.describeDraft(review.proposalId);
  const snapshotPath =
    review?.path || selectedJob?.snapshot.noteRevision?.path || "";

  async function send(mode: CodexReviewInput["mode"]) {
    if (
      !review ||
      !canSend ||
      (mode === "revision" && !canRevise) ||
      (mode === "chat" && feedback.editing !== undefined)
    )
      return;
    const comments =
      mode === "revision" && commentCount ? submittedComments : undefined;
    const instruction = comments
      ? "请按本轮提交的各条意见修订当前待审稿。"
      : currentText ||
        (mode === "revision"
          ? "根据刚才的讨论生成新版，保留本轮未涉及的正文。"
          : "");
    if (!instruction) return;
    const input = {
      mode,
      quote: comments ? undefined : anchor?.text,
      comments,
      codexOptions: options,
    };
    const key = JSON.stringify([review.proposalId, instruction, input]);
    const request =
      feedback.request?.key === key
        ? feedback.request
        : { key, id: crypto.randomUUID() };
    review.onFeedback({ ...feedback, request });
    setBusy(true);
    setError("");
    setStopping("");
    try {
      stickToBottom.current = true;
      await review.onSend({
        feedback: instruction,
        requestId: request.id,
        review: input,
      });
      review.onFeedback(
        mode === "revision"
          ? emptyReviewFeedback
          : clearCurrentOpinion(feedback),
      );
      setPicked(undefined);
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function editOpinion(index: number) {
    if (!review || !canEdit || commentCount > maxRevisionComments) return;
    const queued = enqueueOpinion(feedback);
    const item = queued.comments[index];
    if (!item) return;
    review.onFeedback({
      ...queued,
      instruction: item.text,
      anchor: item.anchor,
      editing: index,
    });
    composer.current?.focus();
  }

  function removeOpinion(index: number) {
    if (!review || !canEdit) return;
    const next =
      feedback.editing === index ? clearCurrentOpinion(feedback) : feedback;
    review.onFeedback({
      ...next,
      comments: next.comments.filter((_, item) => item !== index),
      editing:
        next.editing !== undefined && next.editing > index
          ? next.editing - 1
          : next.editing,
    });
  }

  async function action(id: string, method: "run" | "pause") {
    setError("");
    if (method === "pause") setStopping(id);
    else {
      setBusy(true);
      setStopping("");
    }
    try {
      await api("POST", "/jobs/" + id + "/" + method);
      setReload((n) => n + 1);
      void refresh().catch(() => {});
    } catch (e) {
      setStopping("");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={"codex-conversation" + (review ? " review-chat" : "")}
      aria-label={review ? "Codex 对话" : undefined}
    >
      {review ? (
        <header className="review-chat-header">
          <MessageSquare size={16} />
          <h2>Codex 对话</h2>
          <span className="review-chat-base">{draftLabel}</span>
          <button
            className="icon"
            aria-label="折叠 Codex 对话"
            onClick={review.onClose}
          >
            <X size={17} />
          </button>
        </header>
      ) : (
        <label>
          选择对话
          <select
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setError("");
              setLoadError("");
              stickToBottom.current = true;
            }}
          >
            {available.map(([id, job]) => (
              <option key={id} value={id}>
                {jobTitle(job)} · {shortDate(job.createdAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!review && history?.threadId && (
        <details className="conversation-terminal">
          <summary>在终端打开这条 Codex 会话</summary>
          <code>{"codex resume " + history.threadId}</code>
        </details>
      )}
      <div
        className={
          "conversation-body" + (review && options ? " with-composer" : "")
        }
      >
        <div
          className="conversation-turns"
          aria-label="对话内容"
          ref={messages}
          onScroll={(event) => {
            const area = event.currentTarget;
            stickToBottom.current =
              area.scrollHeight - area.scrollTop - area.clientHeight < 65;
          }}
        >
          {!turns && !loadError && (
            <p className="muted" role="status">
              正在读取对话记录…
            </p>
          )}
          {turns?.map((turn) => {
            const processing = isActive(turn.state);
            const draft = turn.baseId && review?.describeDraft(turn.baseId);
            const status =
              stopping === turn.jobId && processing
                ? "正在停止…"
                : turn.state === "running"
                  ? turn.mode === "chat"
                    ? "正在回复…"
                    : "正在生成新版…"
                  : prettyState(turn.state);
            return (
              <article className="conversation-turn" key={turn.jobId}>
                <div className="conversation-message conversation-request">
                  <div className="conversation-message-heading">
                    <strong>
                      <UserRound size={14} aria-hidden="true" />
                      {turn.comments?.length
                        ? "你 · " + turn.comments.length + " 条修改意见"
                        : turn.mode === "chat"
                          ? "你 · 分析追问"
                          : turn.followUp
                            ? "你 · 修改要求"
                            : "你 · 初次整理"}
                    </strong>
                    <time dateTime={turn.at}>{shortDate(turn.at)}</time>
                  </div>
                  {draft && (
                    <small className="conversation-turn-base">{draft}</small>
                  )}
                  {turn.quote && <blockquote>{turn.quote}</blockquote>}
                  {turn.comments ? (
                    <ol className="conversation-submitted-opinions">
                      {turn.comments.map((comment, index) => (
                        <li key={index}>
                          {comment.anchor && (
                            <blockquote>
                              <small>
                                待审稿{quoteLocation(comment.anchor)}
                              </small>
                              {comment.anchor.text}
                            </blockquote>
                          )}
                          <p className="conversation-user-text">
                            {comment.text}
                          </p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    turn.instruction && (
                      <p className="conversation-user-text">
                        {turn.instruction}
                      </p>
                    )
                  )}
                </div>
                <div className="conversation-message conversation-answer">
                  <div className="conversation-message-heading">
                    <strong>
                      <Sparkles size={14} aria-hidden="true" /> Codex
                    </strong>
                    <span
                      className={"conversation-status " + turn.state}
                      role={processing ? "status" : undefined}
                    >
                      {status}
                    </span>
                  </div>
                  {turn.answer && (
                    <SnapshotText text={turn.answer} path={snapshotPath} />
                  )}
                  {turn.error && <p className="error-text">{turn.error}</p>}
                  {turn.followUp &&
                    ["paused", "failed"].includes(turn.state) && (
                      <button
                        className="text-button"
                        disabled={busy || Boolean(active)}
                        onClick={() => void action(turn.jobId, "run")}
                      >
                        {turn.mode ? "核对或重试这轮" : "重试这轮修改"}
                      </button>
                    )}
                  {turn.replies.map((reply) => {
                    const label = review?.describeDraft(reply.id);
                    return review ? (
                      <button
                        className="conversation-draft"
                        key={reply.id}
                        disabled={!label}
                        onClick={() => review.onOpenDraft(reply.id)}
                      >
                        <span>
                          {turn.followUp ? "查看新版" : "查看初稿"}
                          <small>{label || reply.title}</small>
                        </span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    ) : (
                      <details className="evidence-item" key={reply.id}>
                        <summary>{reply.title}</summary>
                        {reply.markdown && (
                          <SnapshotText
                            text={reply.markdown}
                            path={snapshotPath}
                          />
                        )}
                      </details>
                    );
                  })}
                </div>
              </article>
            );
          })}
          {loadError && (
            <div className="conversation-error" role="alert">
              {loadError}
              <button
                className="text-button"
                onClick={() => setReload((n) => n + 1)}
              >
                重新读取
              </button>
            </div>
          )}
        </div>
        {review && options && (
          <>
            <ReviewDivider pane="composer" controls={composerId} />
            <form
              id={composerId}
              className="review-chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send("chat");
              }}
            >
              <div className="review-composer-body" ref={composerContext}>
                <details className="review-chat-options">
                  <summary>
                    <CodexOptionsSummary
                      value={options}
                      catalog={review.catalog}
                    />
                  </summary>
                  <CodexOptionsFields
                    catalog={review.catalog}
                    value={options}
                    disabled={
                      busy || Boolean(active) || review.connection.checking
                    }
                    onChange={setPicked}
                  />
                </details>
                {!review.connection.ready && (
                  <div className="conversation-connection">
                    <span role="status">{review.connection.label}</span>
                    {!review.connection.checking && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={review.connection.recheck}
                      >
                        重新检查
                      </button>
                    )}
                  </div>
                )}
                {review.baseChanged && (
                  <div className="conversation-base-conflict">
                    <span>原笔记有新改动，写回前请核对。</span>
                    <button
                      type="button"
                      className="text-button"
                      onClick={review.onCompareOriginal}
                    >
                      查看原笔记差异
                    </button>
                  </div>
                )}
                {feedback.comments.length > 0 && (
                  <details className="review-opinions">
                    <summary>
                      已加入 {feedback.comments.length} 条修改意见
                    </summary>
                    <ol aria-label="待提交的修改意见">
                      {feedback.comments.map((comment, index) => (
                        <li
                          key={index}
                          aria-current={
                            index === feedback.editing ? "true" : undefined
                          }
                        >
                          <div>
                            <small>
                              {index + 1}.{" "}
                              {comment.anchor
                                ? quoteLocation(comment.anchor) +
                                  " · " +
                                  comment.anchor.text
                                : "全文"}
                            </small>
                            <span>{comment.text}</span>
                          </div>
                          <button
                            className="text-button"
                            type="button"
                            disabled={!canEdit}
                            aria-label={"编辑第 " + (index + 1) + " 条意见"}
                            onClick={() => editOpinion(index)}
                          >
                            编辑
                          </button>
                          <button
                            className="icon"
                            type="button"
                            disabled={!canEdit}
                            aria-label={"移除第 " + (index + 1) + " 条意见"}
                            onClick={() => removeOpinion(index)}
                          >
                            <X size={13} />
                          </button>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {anchor && (
                  <div className="conversation-quote">
                    <blockquote>
                      <small>待审稿{quoteLocation(anchor)}</small>
                      {anchor.text}
                    </blockquote>
                    <button
                      type="button"
                      className="icon"
                      aria-label="移除引用"
                      disabled={!canEdit}
                      onClick={() =>
                        review.onFeedback({ ...feedback, anchor: undefined })
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>
              <textarea
                ref={composer}
                value={feedback.instruction}
                aria-label="给 Codex 的消息"
                placeholder="写一条问题或修改意见…"
                rows={2}
                maxLength={10000}
                disabled={busy || review.disabled}
                onChange={(event) =>
                  review.onFeedback({
                    ...feedback,
                    instruction: event.target.value,
                  })
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send("chat");
                  }
                }}
              />
              {error && (
                <p role="alert" className="error-text conversation-error">
                  {error}
                </p>
              )}
              <div className="review-composer-actions">
                <div className="review-opinion-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!canAdd}
                    onClick={() => review.onFeedback(enqueueOpinion(feedback))}
                  >
                    {feedback.editing === undefined
                      ? "加入修改意见"
                      : "保存这条意见"}
                  </button>
                  {feedback.editing === undefined ? (
                    <button
                      type="submit"
                      className="text-button"
                      disabled={!canSend || !currentText}
                    >
                      <Send size={13} /> 发送提问
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-button"
                      disabled={!canEdit}
                      onClick={() =>
                        review.onFeedback(clearCurrentOpinion(feedback))
                      }
                    >
                      取消编辑
                    </button>
                  )}
                </div>
                <div className="review-chat-actions">
                  {active ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={stopping === active.jobId}
                      onClick={() => void action(active.jobId, "pause")}
                    >
                      <Square size={12} />{" "}
                      {stopping === active.jobId ? "停止中" : "停止"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={!canRevise}
                      onClick={() => void send("revision")}
                    >
                      {commentCount
                        ? "一次提交 " + commentCount + " 条修改意见"
                        : "按讨论生成新版"}
                    </button>
                  )}
                </div>
              </div>
            </form>
          </>
        )}
      </div>
      {error && !review && (
        <p role="alert" className="error-text conversation-error">
          {error}
        </p>
      )}
    </section>
  );
}
