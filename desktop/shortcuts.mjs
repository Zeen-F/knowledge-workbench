export const DEFAULT_CAPTURE_SHORTCUT = "CommandOrControl+Alt+S";
export function normalizeCaptureShortcut(value, platform = process.platform) {
  if (typeof value !== "string" || value.length > 100)
    throw new Error("请输入有效快捷键");
  const parts = value.split("+").map((s) => s.trim());
  const key = parts.pop()?.toUpperCase();
  const aliases = {
    cmd: "Command",
    command: "Command",
    meta: "Command",
    ctrl: "Control",
    control: "Control",
    cmdorctrl: "CommandOrControl",
    commandorcontrol: "CommandOrControl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
  };
  const modifiers = parts.map((p) => aliases[p.toLowerCase()]);
  if (
    !key ||
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|SPACE)$/.test(key) ||
    modifiers.some((p) => !p) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some((p) => p !== "Shift")
  )
    throw new Error(
      "请使用 Ctrl / Command / Alt 与字母、数字、空格或 F1–F24 的组合",
    );
  if (platform !== "darwin" && modifiers.includes("Command"))
    throw new Error("此平台请使用 Ctrl，不能使用 Command");
  const resolved = modifiers.map((p) =>
    p === "CommandOrControl"
      ? platform === "darwin"
        ? "Command"
        : "Control"
      : p,
  );
  if (new Set(resolved).size !== resolved.length)
    throw new Error("快捷键包含重复修饰键");
  return [
    ...["CommandOrControl", "Command", "Control", "Alt", "Shift"].filter((p) =>
      modifiers.includes(p),
    ),
    key === "SPACE" ? "Space" : key,
  ].join("+");
}
export function formatCaptureShortcut(value, platform = process.platform) {
  return value
    .split("+")
    .map(
      (p) =>
        ({
          CommandOrControl: platform === "darwin" ? "⌘" : "Ctrl",
          Command: "⌘",
          Control: platform === "darwin" ? "⌃" : "Ctrl",
          Alt: platform === "darwin" ? "⌥" : "Alt",
          Shift: platform === "darwin" ? "⇧" : "Shift",
          Space: "空格",
        })[p] || p,
    )
    .join(" + ");
}
export function createCaptureShortcuts({
  shortcuts,
  read,
  write,
  capture,
  record = () => {},
  platform = process.platform,
  enabled = true,
}) {
  let active = null,
    wanted = DEFAULT_CAPTURE_SHORTCUT,
    error = "",
    recording = false;
  const status = () => ({
    accelerator: active || wanted,
    label: formatCaptureShortcut(active || wanted, platform),
    defaultAccelerator: DEFAULT_CAPTURE_SHORTCUT,
    registered: Boolean(active),
    available: enabled,
    error,
  });
  const register = (accelerator) => {
    let ok = false;
    try {
      ok = shortcuts.register(accelerator, () => {
        if (recording) record(accelerator);
        else capture();
      });
    } catch {
      /* Electron rejects unsupported combinations. */
    }
    if (!ok)
      throw new Error("快捷键已被其他程序占用或系统无法注册，原快捷键保持不变");
  };
  return {
    status,
    initialize() {
      try {
        wanted = normalizeCaptureShortcut(
          read()?.capture || DEFAULT_CAPTURE_SHORTCUT,
          platform,
        );
      } catch (e) {
        error = e.message;
        wanted = DEFAULT_CAPTURE_SHORTCUT;
      }
      if (enabled)
        try {
          register(wanted);
          active = wanted;
        } catch (e) {
          error = e.message;
        }
      return status();
    },
    setRecording(value) {
      recording = value === true;
      return status();
    },
    save(value) {
      if (!enabled)
        throw new Error("预览入口不注册全局快捷键，请使用日常桌面应用");
      const next = normalizeCaptureShortcut(value, platform),
        previous = active;
      const changed = next !== previous;
      if (changed) register(next); // Keep the old binding until registration AND persistence succeed.
      try {
        write({ ...read(), capture: next });
      } catch (e) {
        if (changed) shortcuts.unregister(next);
        throw new Error("快捷键保存失败，原快捷键保留：" + e.message);
      }
      active = wanted = next;
      error = "";
      if (changed && previous) shortcuts.unregister(previous);
      return status();
    },
  };
}
