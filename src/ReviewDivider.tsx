import { useLayoutEffect, useRef } from "react";

const splits = {
  chat: {
    orientation: "vertical",
    label: "调整稿件和对话宽度",
    property: "--review-chat-width",
    share: 0.42,
    minimum: 320,
    remainder: 320,
  },
  composer: {
    orientation: "horizontal",
    label: "调整对话记录和输入区高度",
    property: "--review-composer-height",
    share: 0.28,
    minimum: 148,
    remainder: 132,
  },
} as const;

type Limits = { extent: number; min: number; max: number };
const clamp = (size: number, { min, max }: Limits) =>
  Math.round(Math.max(min, Math.min(max, size)));

export function ReviewDivider({
  pane,
  controls,
}: {
  pane: keyof typeof splits;
  controls: string;
}) {
  const split = splits[pane];
  const vertical = split.orientation === "vertical";
  const key = "kwb-review-split:" + pane;
  const handle = useRef<HTMLDivElement>(null);
  const share = useRef<number>(split.share);
  const limits = useRef<Limits>(null);
  const drag = useRef<{ id: number; coordinate: number; size: number }>(null);

  function draw(size: number, range: Limits) {
    const divider = handle.current!;
    divider.parentElement!.style.setProperty(split.property, size + "px");
    divider.setAttribute("aria-valuemin", String(range.min));
    divider.setAttribute("aria-valuemax", String(range.max));
    divider.setAttribute("aria-valuenow", String(size));
  }

  useLayoutEffect(() => {
    const divider = handle.current!;
    const layout = divider.parentElement!;
    try {
      const value = Number(localStorage.getItem(key));
      if (value > 0 && value < 1) share.current = value;
    } catch {
      // The embedded renderer can have restricted storage.
    }
    const measure = () => {
      const extent = vertical ? layout.clientWidth : layout.clientHeight;
      const gutter = vertical ? divider.offsetWidth : divider.offsetHeight;
      if (!extent || !gutter) return;
      const range = {
        extent,
        min: split.minimum,
        max: Math.max(split.minimum, extent - gutter - split.remainder),
      };
      limits.current = range;
      draw(clamp(extent * share.current, range), range);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    observer.observe(divider);
    return () => {
      observer.disconnect();
      layout.style.removeProperty(split.property);
    };
  }, [key, split, vertical]);

  function save() {
    try {
      localStorage.setItem(key, String(share.current));
    } catch {
      // The resizer still works during this visit.
    }
  }
  function resize(size: number, range: Limits) {
    const value = clamp(size, range);
    share.current = value / range.extent;
    draw(value, range);
  }
  function finish(pointerId: number) {
    if (drag.current?.id !== pointerId) return;
    drag.current = null;
    delete handle.current!.dataset.dragging;
    save();
  }

  const decrease = vertical ? "ArrowRight" : "ArrowDown";
  const increase = vertical ? "ArrowLeft" : "ArrowUp";
  return (
    <div
      ref={handle}
      className={"review-divider review-divider-" + split.orientation}
      role="separator"
      tabIndex={0}
      aria-label={split.label}
      aria-controls={controls}
      aria-orientation={split.orientation}
      title={
        vertical
          ? "左右拖动调整宽度，双击恢复默认"
          : "上下拖动调整高度，双击恢复默认"
      }
      onDoubleClick={() => {
        const range = limits.current;
        if (!range) return;
        share.current = split.share;
        draw(clamp(range.extent * split.share, range), range);
        save();
      }}
      onKeyDown={(event) => {
        const range = limits.current;
        if (!range) return;
        const current = clamp(share.current * range.extent, range);
        const destination = {
          [decrease]: current - 16,
          [increase]: current + 16,
          Home: range.min,
          End: range.max,
        }[event.key];
        if (destination === undefined) return;
        event.preventDefault();
        resize(destination, range);
        save();
      }}
      onPointerDown={(event) => {
        const range = limits.current;
        if (event.button !== 0 || !range || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "";
        drag.current = {
          id: event.pointerId,
          coordinate: vertical ? event.clientX : event.clientY,
          size: clamp(share.current * range.extent, range),
        };
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        const range = limits.current;
        if (!active || active.id !== event.pointerId || !range) return;
        const coordinate = vertical ? event.clientX : event.clientY;
        resize(active.size + active.coordinate - coordinate, range);
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onPointerCancel={(event) => finish(event.pointerId)}
      onLostPointerCapture={(event) => finish(event.pointerId)}
    />
  );
}
