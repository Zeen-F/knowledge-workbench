import { useRef, useState, type CSSProperties } from "react";
import { Palette, RotateCcw } from "lucide-react";
import { noteColors, type NoteColor } from "../shared/note-colors";

export function NoteColorMenu({
  onSelect,
}: {
  onSelect: (color: NoteColor | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  function show() {
    const popover = menu.current,
      button = trigger.current;
    if (!popover || !button) return;
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    const anchor = button.getBoundingClientRect();
    popover.showPopover();
    popover.style.left =
      Math.max(
        8,
        Math.min(anchor.left, window.innerWidth - popover.offsetWidth - 8),
      ) + "px";
    popover.style.top =
      (anchor.bottom + popover.offsetHeight + 12 > window.innerHeight
        ? Math.max(8, anchor.top - popover.offsetHeight - 5)
        : anchor.bottom + 5) + "px";
    popover.querySelector("button")?.focus();
  }
  function apply(color: NoteColor | null) {
    menu.current?.hidePopover();
    onSelect(color);
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="note-color-trigger"
        aria-label="文字颜色"
        title="给选中的正文设置颜色"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={show}
      >
        <Palette size={15} />
      </button>
      <div
        ref={menu}
        popover="auto"
        className="note-color-menu"
        role="group"
        aria-label="选择文字颜色"
        onToggle={(event) =>
          setOpen(event.currentTarget.matches(":popover-open"))
        }
      >
        <div className="note-color-swatches">
          {noteColors.map(({ value, night, label }) => (
            <button key={value} type="button" onClick={() => apply(value)}>
              <span
                className="note-inline-color note-color-swatch"
                style={
                  {
                    "--note-color": value,
                    "--note-color-night": night,
                  } as CSSProperties
                }
                aria-hidden="true"
              />
              {label}
            </button>
          ))}
        </div>
        <button
          className="note-color-reset"
          type="button"
          onClick={() => apply(null)}
        >
          <RotateCcw size={14} /> 恢复默认颜色
        </button>
      </div>
    </>
  );
}
