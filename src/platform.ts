export const isMac =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
export const primaryModifier = isMac ? "⌘" : "Ctrl";
export const captureShortcut = isMac ? "⌘ + ⌥ + S" : "Ctrl + Alt + S";
