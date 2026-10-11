import { useMemo, useState } from "react";
import { FileText, Folder } from "lucide-react";
import type { NoteSummary } from "../shared/contracts";

type Branch = {
  notes: NoteSummary[];
  children: Map<string, Branch>;
  count: number;
};
type TreeProps = {
  notes: NoteSummary[];
  active: string;
  dirty: (path: string) => boolean;
  onOpen: (path: string) => void;
};
const PAGE_SIZE = 100;
function BranchNotes({
  branch,
  prefix,
  compact,
  active,
  dirty,
  onOpen,
}: Omit<TreeProps, "notes"> & {
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
      {visible.map((note) => (
        <button
          key={note.path}
          className={`note-row ${active === note.path ? "active" : ""}`}
          title={note.path}
          onClick={() => onOpen(note.path)}
        >
          <FileText size={14} />
          <div>
            <span>{note.title}</span>
          </div>
          {dirty(note.path) && <b className="dirty-dot" />}
        </button>
      ))}
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
          />
        ))}
    </>
  );
}
function TreeFolder(
  props: Omit<TreeProps, "notes"> & {
    name: string;
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
        <span>{props.name}</span>
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
export function NoteTree({ notes, ...props }: TreeProps) {
  const root = useMemo(() => {
    const root: Branch = { notes: [], children: new Map(), count: 0 };
    for (const note of notes) {
      let branch = root;
      branch.count++;
      for (const folder of note.path.split("/").slice(0, -1)) {
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
  }, [notes]);
  return (
    <BranchNotes
      branch={root}
      prefix=""
      compact={notes.length > 300}
      {...props}
    />
  );
}
