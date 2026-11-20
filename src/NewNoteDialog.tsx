import { useState } from "react";
import {
  LEARNING_LOG_TEMPLATES,
  LEARNING_LOG_TEMPLATE_IDS,
  type LearningLogTemplateId,
} from "../shared/learning-log-templates";
import { Modal } from "./Panels";

export type NewNoteType = "concept" | "learning-log";
export type NewNoteInput = { title: string } & (
  | { noteType: "concept" }
  | { noteType: "learning-log"; learningTemplate: LearningLogTemplateId }
);

export function NewNoteDialog({
  initialType,
  initialTitle = "",
  child = false,
  onCreate,
  onClose,
}: {
  initialType: NewNoteType;
  initialTitle?: string;
  child?: boolean;
  onCreate: (note: NewNoteInput) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [type, setType] = useState(initialType);
  const [template, setTemplate] = useState<LearningLogTemplateId>("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { label, headings } = LEARNING_LOG_TEMPLATES[template];

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const name = title.trim() || "未命名笔记";
    try {
      await onCreate(
        type === "learning-log"
          ? { title: name, noteType: type, learningTemplate: template }
          : { title: name, noteType: type },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={child ? "新建子笔记" : "写一篇新笔记"}
      initialFocus='input[name="new-note-title"]'
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          标题
          <input
            name="new-note-title"
            aria-label="新笔记标题"
            value={title}
            maxLength={200}
            readOnly={busy}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="给这篇笔记起个名字"
          />
        </label>
        <label>
          类型
          <select
            value={type}
            disabled={busy}
            onChange={(event) => setType(event.target.value as NewNoteType)}
          >
            <option value="concept">主题知识卡</option>
            <option value="learning-log">学习记录</option>
          </select>
        </label>
        {type === "learning-log" && (
          <>
            <fieldset className="learning-template-picker" disabled={busy}>
              <legend>学习记录模板</legend>
              <div className="learning-template-options">
                {LEARNING_LOG_TEMPLATE_IDS.map((id) => (
                  <label className="learning-template-option" key={id}>
                    <input
                      type="radio"
                      name="learning-template"
                      checked={template === id}
                      onChange={() => setTemplate(id)}
                    />
                    {LEARNING_LOG_TEMPLATES[id].label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div
              className="learning-template-preview"
              role="region"
              aria-label="模板预览"
              aria-live="polite"
            >
              <strong>{label}</strong>
              {headings.length > 0 ? (
                <ul>
                  {headings.map((heading) => (
                    <li key={heading}>{heading}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  {child
                    ? "从空白正文开始，可点击链接返回父笔记。"
                    : "正文只插入笔记标题。"}
                </p>
              )}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="note-create-error">
            {error}
          </p>
        )}
        <footer className="modal-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "正在创建…" : child ? "创建并打开" : "开始写作"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
