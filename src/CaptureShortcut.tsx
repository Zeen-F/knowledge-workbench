import { useEffect, useRef, useState } from "react";
import { isMac } from "./platform";
type ShortcutState = {
  accelerator: string;
  label: string;
  defaultAccelerator: string;
  registered: boolean;
  available: boolean;
  error: string;
};
const changed = "workbench-shortcut-changed";
const native = () =>
  Boolean(
    window.workbench &&
      !window.workbench.panel &&
      window.workbench.onShortcutRecorded,
  );
const request = (body?: unknown): Promise<ShortcutState> =>
  window.workbench!.invoke("DESKTOP", "/shortcuts", body);
export function useCaptureShortcut() {
  const [state, setState] = useState<ShortcutState | null>(null);
  useEffect(() => {
    if (!native()) return;
    let disposed = false;
    void request()
      .then((s) => {
        if (!disposed) setState(s);
      })
      .catch(() => {});
    const receive = (e: Event) =>
      setState((e as CustomEvent<ShortcutState>).detail);
    window.addEventListener(changed, receive);
    return () => {
      disposed = true;
      window.removeEventListener(changed, receive);
    };
  }, []);
  return state;
}
export function CaptureShortcutSettings() {
  const state = useCaptureShortcut();
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    if (state) setDraft(state.accelerator);
  }, [state]);
  useEffect(() => {
    alive.current = true;
    const off = window.workbench?.onShortcutRecorded?.((accelerator) =>
      setDraft(accelerator),
    );
    const blur = () => {
      setRecording(false);
      if (native())
        void request({ action: "record", recording: false }).catch(() => {});
    };
    window.addEventListener("blur", blur);
    return () => {
      alive.current = false;
      off?.();
      window.removeEventListener("blur", blur);
      if (native())
        void request({ action: "record", recording: false }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (recording) input.current?.focus();
  }, [recording]);
  async function record() {
    setError("");
    setResult("");
    setBusy(true);
    try {
      await request({ action: "record", recording: true });
      if (alive.current) setRecording(true);
      else await request({ action: "record", recording: false });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setRecording(false);
    try {
      await request({ action: "record", recording: false });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(accelerator: string) {
    setBusy(true);
    setError("");
    setResult("");
    try {
      await stop();
      const next = await request({ action: "save", accelerator });
      window.dispatchEvent(new CustomEvent(changed, { detail: next }));
      setResult("快捷键已保存，重新打开后沿用。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <div className="section-label">框选截图快捷键</div>
      {!native() ? (
        <p>请在日常桌面应用中设置全局快捷键。</p>
      ) : (
        <>
          <p role="status">
            {state
              ? `当前：${state.label}${state.registered ? "" : "（未注册，仍可点击框选截图）"}`
              : "正在读取快捷键…"}
          </p>
          {state?.error && <p role="alert">{state.error}</p>}
          <label>
            快捷键组合
            <input
              ref={input}
              aria-label="框选截图快捷键"
              value={draft}
              readOnly
              disabled={!recording}
              placeholder="点击录入，再按组合键"
              onBlur={() => {
                if (recording) void stop();
              }}
              onKeyDown={(e) => {
                if (!recording) return;
                if (e.key === "Tab") {
                  void stop();
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") {
                  void stop();
                  return;
                }
                if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
                const key = /^Key[A-Z]$/.test(e.code)
                  ? e.code.slice(3)
                  : /^Digit[0-9]$/.test(e.code)
                    ? e.code.slice(5)
                    : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(e.code)
                      ? e.code
                      : e.code === "Space"
                        ? "Space"
                        : "";
                const modifiers = [
                  e.metaKey ? (isMac ? "CommandOrControl" : "Command") : "",
                  e.ctrlKey ? (isMac ? "Control" : "CommandOrControl") : "",
                  e.altKey ? "Alt" : "",
                  e.shiftKey ? "Shift" : "",
                ].filter(Boolean);
                if (!key || !modifiers.some((m) => m !== "Shift")) {
                  setError(
                    "请按 Ctrl / Command / Alt 与字母、数字、空格或功能键的组合",
                  );
                  return;
                }
                setError("");
                setDraft([...modifiers, key].join("+"));
              }}
            />
          </label>
          <p className="muted">
            录入时不会触发本应用截图。Tab 或 Esc
            结束录入；占用或保存失败时保留原快捷键。
          </p>
          <div className="button-row">
            <button
              className="secondary"
              disabled={busy || !state?.available}
              onClick={() => void record()}
            >
              录入快捷键
            </button>
            <button
              className="primary"
              disabled={busy || !draft || !state?.available}
              onClick={() => void save(draft)}
            >
              保存快捷键
            </button>
            <button
              className="secondary"
              disabled={busy || !state?.available}
              onClick={() => void save(state!.defaultAccelerator)}
            >
              恢复默认快捷键
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          {result && <p role="status">{result}</p>}
        </>
      )}
    </section>
  );
}
