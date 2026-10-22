import { useRef, useState } from "react";
import type { Capture } from "../shared/contracts";
import { api } from "./client";
import { Modal } from "./Panels";

export function CaptureTrash({
  targets,
  visibleIds,
  onClose,
  onDeleted,
  refresh,
  enabled,
}: {
  targets: Capture[];
  visibleIds: string[];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
  refresh: () => Promise<void>;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [trash, setTrash] = useState<Capture[]>([]);
  const [undo, setUndo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const locked = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const load = async () =>
    setTrash(await api<Capture[]>("GET", "/captures?deleted=true"));
  async function showTrash() {
    if (locked.current) return;
    setOpen(true);
    setError("");
    setBusy(true);
    locked.current = true;
    try {
      await load();
    } catch (e) {
      setError("读取已删除材料失败：" + (e as Error).message);
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }
  async function change(ids: string[], deleted: boolean) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    let saved = false;
    try {
      await api("POST", deleted ? "/captures/trash" : "/captures/restore", {
        ids,
      });
      saved = true;
      if (deleted) {
        setUndo(ids);
        onDeleted(ids);
        onClose();
      } else {
        setUndo((previous) => previous.filter((id) => !ids.includes(id)));
        setTrash((previous) => previous.filter((c) => !ids.includes(c.id)));
      }
      setMessage(
        deleted
          ? `已从收集箱删除 ${ids.length} 份材料，可随时恢复。`
          : `已恢复 ${ids.length} 份材料。`,
      );
      await refresh();
      if (open) await load();
    } catch (e) {
      setError(
        (saved
          ? "操作已保存，但列表刷新失败。请重试刷新："
          : "操作未确认完成，可重试或在已删除中核对：") + (e as Error).message,
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const hidden = targets.filter((c) => !visibleIds.includes(c.id)).length;
  return (
    <>
      <div className="capture-trash-tools">
        <button
          ref={trigger}
          className="secondary"
          disabled={!enabled || busy}
          onClick={() => void showTrash()}
          title={!enabled ? "请先更新桌面服务" : undefined}
        >
          已删除 · 恢复材料
        </button>
        {message && <span role="status">{message}</span>}
        {undo.length > 0 && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void change(undo, false)}
          >
            撤销删除 {undo.length} 份
          </button>
        )}
      </div>
      {error && !targets.length && !open && (
        <div role="alert" className="capture-trash-error">
          {error}
          <button
            onClick={() =>
              void refresh()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
          >
            重试刷新
          </button>
        </div>
      )}
      {targets.length > 0 && (
        <Modal
          title={`删除 ${targets.length} 份材料？`}
          onClose={() => {
            if (!busy) {
              setError("");
              onClose();
            }
          }}
          fallbackFocus={() => trigger.current?.focus()}
        >
          <p>
            仅从收集箱移入“已删除”，可随时恢复。原始
            Markdown、共享图片、已有笔记和已建立的整理批次均保留。
          </p>
          {hidden > 0 && (
            <p className="capture-trash-scope">
              包括 {hidden} 份被当前筛选隐藏的已选材料。
            </p>
          )}
          <ul className="capture-trash-list" aria-label="将删除的材料">
            {targets.map((c) => (
              <li key={c.id}>{c.ref.title}</li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="capture-trash-error">
              {error}
            </p>
          )}
          <footer className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setError("");
                onClose();
              }}
            >
              取消
            </button>
            <button
              className="capture-delete"
              disabled={busy}
              onClick={() =>
                void change(
                  targets.map((c) => c.id),
                  true,
                )
              }
            >
              {busy ? "正在处理…" : `确认删除 ${targets.length} 份`}
            </button>
          </footer>
        </Modal>
      )}
      {open && (
        <Modal
          title="已删除的材料"
          onClose={() => {
            if (!busy) {
              setOpen(false);
              setError("");
            }
          }}
          fallbackFocus={() => trigger.current?.focus()}
        >
          <p>这里只恢复收集箱记录，原文件和已有笔记始终保留。</p>
          {error && (
            <p role="alert" className="capture-trash-error">
              {error}
            </p>
          )}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void showTrash()}
          >
            刷新已删除列表
          </button>
          {busy && <p role="status">正在处理…</p>}
          {!busy && !error && trash.length === 0 && <p>没有已删除的材料</p>}
          <ul className="capture-trash-list" aria-label="已删除材料列表">
            {trash.map((c) => (
              <li key={c.id}>
                <span>{c.ref.title}</span>
                <button
                  className="secondary"
                  disabled={busy}
                  aria-label={`恢复 ${c.ref.title}`}
                  onClick={() => void change([c.id], false)}
                >
                  恢复
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
