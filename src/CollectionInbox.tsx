import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { CollectionTask } from "../shared/contracts";
import { api } from "./client";
import { Inbox, Modal } from "./Panels";

type Props = Omit<ComponentProps<typeof Inbox>, "taskId" | "registerGuard"> & {
  registerLeave: (guard: (() => Promise<boolean>) | null) => void;
  onCancel: () => void;
};
const desktop = () =>
  Boolean(window.workbench?.onCollectionRequested && !window.workbench.panel);
const activate = async (taskId: string | null) => {
  if (desktop())
    return await window.workbench!.invoke("DESKTOP", "/collection", { taskId });
};
export function CollectionInbox(props: Props) {
  const [tasks, setTasks] = useState<CollectionTask[]>([]);
  const [active, setActive] = useState<CollectionTask | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const guard = useRef<(() => Promise<boolean>) | null>(null);
  const locked = useRef(false);
  const leaving = useRef(false);
  const currentProps = useRef(props);
  currentProps.current = props;
  const load = () =>
    api<CollectionTask[]>("GET", "/collection-tasks").then(setTasks);
  async function leave() {
    if (locked.current || leaving.current) return false;
    leaving.current = true;
    try {
      if (guard.current && !(await guard.current())) return false;
      await activate(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      leaving.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    currentProps.current.registerLeave(leave);
    void load().catch((e) => setError(e.message));
    return () => {
      mounted.current = false;
      currentProps.current.registerLeave(null);
      void activate(null).catch(() => {});
    };
  }, []);
  async function select(task: CollectionTask) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await api("POST", "/collection-tasks/state", {
        taskId: task.id,
        ended: false,
      });
      const result = await activate(task.id);
      if (!mounted.current) {
        await activate(null);
        return;
      }
      guard.current = null;
      setActive({ ...task, ended: false });
      if (result?.captureRequested)
        void window
          .workbench!.capture(task.id)
          .catch((e) => props.notify(e.message, true));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function create() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    let task: CollectionTask | undefined;
    try {
      task = await api("POST", "/collection-tasks", { name });
      await load();
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
    if (task) await select(task);
  }
  async function change(end: boolean) {
    if (!(await leave())) return;
    try {
      if (end && active)
        await api("POST", "/collection-tasks/state", {
          taskId: active.id,
          ended: true,
        });
      guard.current = null;
      setActive(null);
      await load();
    } catch (e) {
      // Keep the current task visible if its durable state could not be saved.
      if (active) await activate(active.id).catch(() => {});
      setError((e as Error).message);
    }
  }
  const history: CollectionTask = {
    id: "history",
    name: "未分类 / 历史收集",
    createdAt: "",
    updatedAt: "",
    ended: false,
    count: props.captures.filter((c) => !c.ref.taskId).length,
  };
  return (
    <>
      <section className="collection-task-bar" aria-label="当前收集任务">
        <div>
          <small>本次学习收集</small>
          <h2>{active?.name || "选择一个收集任务"}</h2>
        </div>
        {active && (
          <div className="button-row">
            <button onClick={() => void change(false)}>切换任务</button>
            <button onClick={() => void change(true)}>结束本次收集</button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
      {active ? (
        <Inbox
          {...props}
          key={active.id}
          taskId={active.id}
          registerGuard={(fn) => {
            guard.current = fn;
          }}
          captures={props.captures.filter(
            (c) => (c.ref.taskId || "history") === active.id,
          )}
          jobs={props.jobs.filter(
            (j) => (j.snapshot.taskId || "history") === active.id,
          )}
        />
      ) : (
        <Modal
          title="选择本次收集任务"
          onClose={() => {
            if (!busy)
              void leave().then((ok) => {
                if (ok) props.onCancel();
              });
          }}
        >
          <p>
            新建一次学习收集，或继续已有任务。截图、图片和想法只进入本次选择的任务。
          </p>
          <label>
            任务名称
            <input
              aria-label="新收集任务名称"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </label>
          <button disabled={busy || !name.trim()} onClick={() => void create()}>
            新建并开始收集
          </button>
          {error && <p role="alert">{error}</p>}
          <ul className="collection-task-list" aria-label="已有收集任务">
            {tasks.map((task) => (
              <li key={task.id}>
                <span>
                  {task.name}
                  <small>
                    {task.count} 份材料 ·{" "}
                    {task.ended ? "已结束，可继续" : "可继续收集"}
                  </small>
                </span>
                <button
                  disabled={busy}
                  aria-label={`继续任务 ${task.name}`}
                  onClick={() => void select(task)}
                >
                  继续
                </button>
              </li>
            ))}
          </ul>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void select(history)}
          >
            未分类 / 历史收集 · {history.count} 份
          </button>
          <p className="muted">
            历史原文件保持原位置；选择此入口不会移动或合并资料。
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void leave().then((ok) => {
                if (ok) props.onCancel();
              })
            }
          >
            取消收集
          </button>
        </Modal>
      )}
    </>
  );
}
