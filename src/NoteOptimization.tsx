import { useEffect, useMemo, useState } from "react";
import {
  MAX_OPTIMIZATION_REFERENCES,
  type BatchPreview,
  type Job,
  type NoteOptimizationInput,
  type NoteSummary,
} from "../shared/contracts";
import { api, type ApiError } from "./client";
import { Modal, codexCliLabels, useCodexCliStatus } from "./Panels";
import { matchesNoteSection } from "./note-navigation";
import type { CodexOptions } from "../shared/codex-options";
import { CodexOptionsFields, CodexOptionsSummary } from "./CodexOptions";
import { assetUrl } from "./markdown";

type NoteRelations = {
  outgoing: { to_ref: string; kind: string; resolved: boolean }[];
  incoming: { from_path: string }[];
};

export function NoteOptimization({
  note,
  notes,
  scope,
  saveSelected,
  onStarted,
  onClose,
}: {
  note: NoteSummary;
  notes: NoteSummary[];
  scope: NoteOptimizationInput["scope"];
  saveSelected: (paths: string[]) => Promise<void>;
  onStarted: (job: Job) => void;
  onClose: () => void;
}) {
  const [catalog] = useState(
    () =>
      new Map(
        notes
          .filter(
            (candidate) =>
              candidate.path !== note.path &&
              matchesNoteSection(candidate, "all"),
          )
          .map((candidate) => [candidate.path, candidate]),
      ),
  );
  const [suggested, setSuggested] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<{
    data: BatchPreview;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cli = useCodexCliStatus(true, true);
  const [pickedCodex, setPickedCodex] = useState<CodexOptions>();
  const codexOptions = pickedCodex ?? cli.defaults;

  useEffect(() => {
    let active = true;
    const tags = new Set(note.tags.map((tag) => tag.toLocaleLowerCase()));
    const tagged = [...catalog.values()].filter((candidate) =>
      candidate.tags.some((tag) => tags.has(tag.toLocaleLowerCase())),
    );
    const recommend = (connected: string[]) => {
      if (!active) return;
      const paths = [
        ...new Set([
          ...connected,
          ...tagged.map((candidate) => candidate.path),
        ]),
      ]
        .filter((relative) => catalog.has(relative))
        .slice(0, 5);
      setSuggested(paths);
      setSelected(paths);
      setLoading(false);
    };
    void api<NoteRelations>(
      "GET",
      "/relations?path=" + encodeURIComponent(note.path),
    )
      .then(({ outgoing, incoming }) =>
        recommend([
          ...outgoing
            .filter((link) => link.kind === "note" && link.resolved)
            .map((link) => link.to_ref),
          ...incoming.map((link) => link.from_path),
        ]),
      )
      .catch(() => recommend([]));
    return () => {
      active = false;
    };
  }, [catalog, note]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = needle
      ? [...catalog.values()]
          .filter((item) =>
            `${item.title}\n${item.path}\n${item.tags.join(" ")}`
              .toLocaleLowerCase()
              .includes(needle),
          )
          .slice(0, 50)
          .map((item) => item.path)
      : suggested;
    return [...new Set([...selected, ...matches])].map(
      (relative) => catalog.get(relative)!,
    );
  }, [catalog, query, selected, suggested]);

  async function advance() {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    try {
      const input: NoteOptimizationInput = {
        path: note.path,
        scope,
        referencePaths: selected,
        instruction: instruction.trim(),
        codexOptions: preview ? preview.data.codexOptions : codexOptions,
      };
      if (preview) {
        const job = await api<Job>("POST", "/note/optimize", {
          ...input,
          requestId: preview.requestId,
          expectedPreviewHash: preview.data.previewHash,
        });
        onStarted(job);
      } else {
        await saveSelected([note.path, ...selected]);
        const data = await api<BatchPreview>(
          "POST",
          "/note/optimize/preview",
          input,
        );
        setPreview({ data, requestId: crypto.randomUUID() });
      }
    } catch (e) {
      if ((e as ApiError).code === "PREVIEW_CHANGED") setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="交给 Codex 优化"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="optimization-target">
        <strong>{preview?.data.noteRevision?.title ?? note.title}</strong>
        <p className="material-path">{note.path}</p>
      </div>
      {preview?.data.noteRevision ? (
        <section className="optimization-preview" aria-label="发送内容预览">
          <p>
            本机 Codex 将收到这篇笔记和 {preview.data.references.length}{" "}
            篇已选参考的正文，以及目标笔记的{" "}
            {preview.data.noteRevision.images?.length ?? 0}{" "}
            张图片。优化稿会进入「待审稿」。
          </p>
          {preview.data.codexOptions && (
            <CodexOptionsSummary
              value={preview.data.codexOptions}
              catalog={cli.catalog}
            />
          )}
          {preview.data.instruction && (
            <p className="optimization-instruction">
              <strong>补充要求</strong> {preview.data.instruction}
            </p>
          )}
          {Boolean(preview.data.noteRevision.annotations?.length) && (
            <details className="evidence-item" open>
              <summary>
                笔记里的批注与问题（
                {preview.data.noteRevision.annotations!.length}）
              </summary>
              <ol className="annotation-preview">
                {preview.data.noteRevision.annotations!.map((item) => (
                  <li key={item.line}>
                    <small>
                      正文第 {item.line} 行
                      {item.nearbyImage ? " · 附近图 " + item.nearbyImage : ""}
                    </small>
                    <p>{item.text}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {Boolean(
            preview.data.noteRevision.images?.length ||
              preview.data.noteRevision.imageIssues?.length,
          ) && (
            <details className="evidence-item">
              <summary>
                随正文交接的图片（
                {preview.data.noteRevision.images?.length ?? 0}）
              </summary>
              <div className="optimization-images">
                {preview.data.noteRevision.images?.map((image, index) => (
                  <figure key={image.path + ":" + image.line + ":" + index}>
                    <img
                      src={assetUrl(image.path)}
                      alt={"正文第 " + image.line + " 行的图片"}
                      loading="lazy"
                    />
                    <figcaption>
                      图 {index + 1} · 正文第 {image.line} 行
                    </figcaption>
                  </figure>
                ))}
              </div>
              {preview.data.noteRevision.imageIssues?.map((issue, index) => (
                <p key={index} className="muted">
                  正文第 {issue.line} 行 · {issue.detail}
                </p>
              ))}
            </details>
          )}
          <details className="evidence-item" open>
            <summary>目标笔记正文</summary>
            <pre>{preview.data.noteRevision.content}</pre>
          </details>
          {preview.data.references.map((reference) => (
            <details className="evidence-item" key={reference.path}>
              <summary>{reference.title}</summary>
              <p className="material-path">{reference.path}</p>
              <pre>{reference.content}</pre>
            </details>
          ))}
        </section>
      ) : (
        <>
          <CodexOptionsFields
            catalog={cli.catalog}
            value={codexOptions}
            disabled={busy || cli.state === "checking"}
            onChange={setPickedCodex}
          />
          <label>
            优化要求（可选）
            <textarea
              value={instruction}
              maxLength={2000}
              rows={2}
              placeholder="例如保留推导，合并重复段落，标出还需验证的问题。"
              disabled={busy}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <fieldset
            className="optimization-references"
            disabled={loading || busy}
          >
            <legend>
              参考笔记 · 已选 {selected.length}/{MAX_OPTIMIZATION_REFERENCES}
            </legend>
            <input
              aria-label="搜索参考笔记"
              type="search"
              value={query}
              placeholder="搜索标题、路径或标签，添加参考"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="optimization-reference-list">
              {visible.map((candidate) => {
                const checked = selected.includes(candidate.path);
                return (
                  <label
                    key={candidate.path}
                    className="optimization-reference"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={
                        !checked &&
                        selected.length >= MAX_OPTIMIZATION_REFERENCES
                      }
                      onChange={(event) => {
                        setSelected((paths) =>
                          event.target.checked
                            ? [...paths, candidate.path]
                            : paths.filter(
                                (relative) => relative !== candidate.path,
                              ),
                        );
                      }}
                    />
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>{candidate.path}</small>
                    </span>
                  </label>
                );
              })}
              {!visible.length && (
                <p className="muted">
                  {loading
                    ? "正在查找关联笔记…"
                    : query
                      ? "没有匹配的参考笔记。"
                      : "没有推荐的关联笔记，可以搜索添加。"}
                </p>
              )}
            </div>
          </fieldset>
        </>
      )}
      <div className="executor-status">
        <span role="status">{codexCliLabels[cli.state]}</span>
        {cli.state !== "checking" &&
          (!cli.catalog || cli.state !== "ready") && (
            <button className="secondary" onClick={cli.recheck}>
              重新检查
            </button>
          )}
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <footer className="modal-footer">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (preview) {
              setPreview(null);
              setError("");
            } else onClose();
          }}
        >
          {preview ? "返回选择" : "取消"}
        </button>
        <button
          className="primary"
          disabled={
            loading ||
            busy ||
            cli.state === "checking" ||
            Boolean(preview && cli.state !== "ready")
          }
          onClick={() => void advance()}
        >
          {busy ? "正在准备…" : preview ? "确认并交给 Codex" : "预览发送内容"}
        </button>
      </footer>
    </Modal>
  );
}
