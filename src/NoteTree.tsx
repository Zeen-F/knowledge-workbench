import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Folder,
  Link2,
  MoveRight,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { NoteSummary } from "../shared/contracts";

type Branch = {
  notes: NoteSummary[];
  children: Map<string, Branch>;
  count: number;
};
type TreeProps = {
  notes: NoteSummary[];
  basePath?: string;
  active: string;
  dirty: (path: string) => boolean;
  onOpen: (path: string) => void;
};
type MenuOpener = (
  button: HTMLButtonElement,
  note: NoteSummary,
  x: number,
  y: number,
) => void;
type BranchProps = Omit<TreeProps, "notes"> & { openMenu?: MenuOpener };
type NoteAction = "title" | "move" | "copy-link" | "optimize" | "delete";
const PAGE_SIZE = 100;
function BranchNotes({
  branch,
  prefix,
  compact,
  active,
  dirty,
  onOpen,
  openMenu,
  basePath,
}: BranchProps & {
  branch: Branch;
  prefix: string;
  compact: boolean;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const visible = branch.notes.slice(0, limit);
  const selected = branch.notes.find((note) => note.path === active);
  if (selected && !visible.includes(selected)) visible.push(selected);
  return (
    <>
      {visible.map((note) => {
        return (
          <button
            key={note.path}
            className={`note-row ${active === note.path ? "active" : ""}`}
            title={note.path}
            aria-haspopup={openMenu ? "menu" : undefined}
            onClick={() => onOpen(note.path)}
            onContextMenu={
              openMenu &&
              ((event) => {
                event.preventDefault();
                openMenu(
                  event.currentTarget,
                  note,
                  event.clientX,
                  event.clientY,
                );
              })
            }
            onKeyDown={
              openMenu &&
              ((event) => {
                if (
                  event.key !== "ContextMenu" &&
                  !(event.shiftKey && event.key === "F10")
                )
                  return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                openMenu(event.currentTarget, note, bounds.left, bounds.bottom);
              })
            }
          >
            <FileText size={14} />
            <div>
              <span>{note.title}</span>
            </div>
            {dirty(note.path) && <b className="dirty-dot" />}
          </button>
        );
      })}
      {branch.notes.length > limit && (
        <button
          className="note-row note-more"
          onClick={() => setLimit((value) => value + PAGE_SIZE)}
        >
          再显示 {Math.min(PAGE_SIZE, branch.notes.length - limit)} 篇（共{" "}
          {branch.notes.length} 篇）
        </button>
      )}
      {[...branch.children]
        .sort(([a], [b]) => a.localeCompare(b, "zh"))
        .map(([name, child]) => (
          <TreeFolder
            key={name}
            name={name}
            branch={child}
            prefix={prefix + name + "/"}
            compact={compact}
            active={active}
            dirty={dirty}
            onOpen={onOpen}
            openMenu={openMenu}
            basePath={basePath}
            label={
              basePath && prefix === basePath + "/"
                ? { Cards: "知识卡", Journal: "学习记录", Assets: "附件" }[
                    name
                  ] || name
                : name
            }
          />
        ))}
    </>
  );
}
function TreeFolder(
  props: BranchProps & {
    name: string;
    label: string;
    branch: Branch;
    prefix: string;
    compact: boolean;
  },
) {
  const [choice, setChoice] = useState<{ active: string; open: boolean }>();
  // A newly opened note remains reachable even if its folder was collapsed.
  const open =
    choice?.active === props.active
      ? choice.open
      : !props.compact || props.active.startsWith(props.prefix);
  return (
    <details open={open} className="note-folder">
      <summary
        onClick={(event) => {
          event.preventDefault();
          setChoice({ active: props.active, open: !open });
        }}
      >
        <Folder size={14} />
        <span>{props.label}</span>
        <small>{props.branch.count}</small>
      </summary>
      {open && (
        <div>
          <BranchNotes {...props} />
        </div>
      )}
    </details>
  );
}
export function NoteTree({
  notes,
  basePath = "",
  onAction,
  canOptimize = false,
  ...props
}: TreeProps & {
  onAction?: (action: NoteAction, note: NoteSummary) => void;
  canOptimize?: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const target = useRef<{
    button: HTMLButtonElement;
    path: string;
    top: number;
    left: number;
  }>(null);
  useEffect(() => {
    const dismiss = (event: Event) => {
      const popover = menu.current;
      if (
        popover?.matches(":popover-open") &&
        !event.composedPath().includes(popover)
      )
        popover.hidePopover();
    };
    const dismissOnScroll = () => {
      if (!target.current || !menu.current?.matches(":popover-open")) return;
      const { button, top, left } = target.current;
      const bounds = button.getBoundingClientRect();
      if (!button.isConnected || bounds.top !== top || bounds.left !== left)
        menu.current.hidePopover();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, []);
  function closeMenu() {
    menu.current?.hidePopover();
    target.current?.button.focus({ preventScroll: true });
  }
  const openMenu: MenuOpener = (button, note, x, y) => {
    const item = menu.current!;
    if (item.matches(":popover-open")) item.hidePopover();
    const { top, left } = button.getBoundingClientRect();
    target.current = { button, path: note.path, top, left };
    for (const control of item.querySelectorAll<HTMLElement>(
      "[data-note-edit]",
    ))
      control.hidden = note.owner === "paperdesk";
    button.focus({ preventScroll: true });
    item.showPopover();
    item.style.left = `${Math.max(6, Math.min(x, window.innerWidth - item.offsetWidth - 6))}px`;
    item.style.top = `${Math.max(6, Math.min(y, window.innerHeight - item.offsetHeight - 6))}px`;
    item
      .querySelector<HTMLButtonElement>("button:not([hidden])")
      ?.focus({ preventScroll: true });
  };
  function choose(action: NoteAction) {
    closeMenu();
    const note = notes.find((note) => note.path === target.current?.path);
    if (note && (action === "copy-link" || note.owner !== "paperdesk"))
      onAction?.(action, note);
  }
  const base = basePath ? basePath.replace(/\/$/, "") + "/" : "";
  const root = useMemo(() => {
    const root: Branch = { notes: [], children: new Map(), count: 0 };
    for (const note of notes) {
      let branch = root;
      branch.count++;
      for (const folder of (base && note.path.startsWith(base)
        ? note.path.slice(base.length)
        : note.path
      )
        .split("/")
        .slice(0, -1)) {
        if (!branch.children.has(folder))
          branch.children.set(folder, {
            notes: [],
            children: new Map(),
            count: 0,
          });
        branch = branch.children.get(folder)!;
        branch.count++;
      }
      branch.notes.push(note);
    }
    return root;
  }, [notes, base]);
  return (
    <>
      <BranchNotes
        branch={root}
        prefix={base}
        basePath={basePath}
        compact={notes.length > 300}
        openMenu={onAction ? openMenu : undefined}
        {...props}
      />
      {onAction && (
        <div
          ref={menu}
          popover="manual"
          className="note-context-menu"
          role="menu"
          aria-label="笔记操作"
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") closeMenu();
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not([hidden])",
              ),
            ];
            const current = items.findIndex(
              (item) => item === document.activeElement,
            );
            const offset = event.key === "ArrowUp" ? -1 : 1;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current + offset + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <button
            role="menuitem"
            tabIndex={-1}
            data-note-edit
            onClick={() => choose("title")}
          >
            <Pencil size={15} /> 修改标题
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            data-note-edit
            onClick={() => choose("move")}
          >
            <MoveRight size={15} /> 重命名或移动笔记
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            onClick={() => choose("copy-link")}
          >
            <Link2 size={15} /> 复制笔记链接
          </button>
          {canOptimize && (
            <button
              role="menuitem"
              tabIndex={-1}
              data-note-edit
              onClick={() => choose("optimize")}
            >
              <Sparkles size={15} /> 交给 Codex 优化
            </button>
          )}
          <hr data-note-edit />
          <button
            role="menuitem"
            tabIndex={-1}
            className="note-delete-action"
            data-note-edit
            onClick={() => choose("delete")}
          >
            <Trash2 size={15} /> 删除笔记
          </button>
        </div>
      )}
    </>
  );
}
