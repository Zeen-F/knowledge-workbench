import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "kwb-sidebar-layout:v1";
const DEFAULT_WIDTH = 244;
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
type Layout = { width: number; collapsed: boolean };
function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (
      saved &&
      Number.isFinite(saved.width) &&
      typeof saved.collapsed === "boolean"
    )
      return {
        width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved.width)),
        collapsed: saved.collapsed,
      };
  } catch {
    // Native Codex panels can disable browser storage. Layout still works.
  }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

export function useSidebarLayout() {
  const [layout, setLayout] = useState(readLayout);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const current = useRef(layout);
  const drag = useRef<{ pointer: number; left: number } | null>(null);
  const maximum = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewportWidth - 420));
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  function update(next: Layout, persist = true) {
    current.current = next;
    setLayout(next);
    if (persist)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Layout persistence is optional; never block editing in a sandbox.
      }
  }
  function width(value: number, persist = true) {
    update(
      {
        ...current.current,
        width: Math.round(Math.max(MIN_WIDTH, Math.min(maximum, value))),
      },
      persist,
    );
  }
  function finish() {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    update(current.current);
  }
  const visibleWidth = Math.min(layout.width, maximum);
  return {
    collapsed: layout.collapsed,
    width: visibleWidth,
    dragging,
    toggle: () =>
      update({ ...current.current, collapsed: !current.current.collapsed }),
    separator: (
      <div
        className="sidebar-resizer"
        role="separator"
        tabIndex={0}
        aria-label="调整导航侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={visibleWidth}
        title="拖动调整宽度，双击恢复默认；也可使用左右方向键"
        onDoubleClick={() => width(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const next = {
            ArrowLeft: visibleWidth - 16,
            ArrowRight: visibleWidth + 16,
            Home: MIN_WIDTH,
            End: maximum,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          width(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointer: event.pointerId,
            left: event.currentTarget.parentElement!.getBoundingClientRect()
              .left,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointer === event.pointerId)
            width(event.clientX - drag.current.left, false);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
    ),
  };
}
