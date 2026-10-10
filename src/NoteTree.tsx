import { FileText, Folder } from "lucide-react";
import type { NoteSummary } from "../shared/contracts";

type Branch = { notes: NoteSummary[]; children: Map<string, Branch> };
export function NoteTree({
  notes,
  basePath = "",
  active,
  dirty,
  onOpen,
}: {
  notes: NoteSummary[];
  basePath?: string;
  active: string;
  dirty: (path: string) => boolean;
  onOpen: (path: string) => void;
}) {
  const root: Branch = { notes: [], children: new Map() };
  for (const note of notes) {
    let branch = root;
    const relative =
      basePath && note.path.startsWith(basePath + "/")
        ? note.path.slice(basePath.length + 1)
        : note.path;
    for (const folder of relative.split("/").slice(0, -1)) {
      if (!branch.children.has(folder))
        branch.children.set(folder, { notes: [], children: new Map() });
      branch = branch.children.get(folder)!;
    }
    branch.notes.push(note);
  }
  const render = (branch: Branch, prefix = "") => (
    <>
      {branch.notes.map((note) => (
        <button
          key={note.path}
          className={active === note.path ? "active" : ""}
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
      {[...branch.children]
        .sort(([a], [b]) => a.localeCompare(b, "zh"))
        .map(([name, child]) => (
          <details key={prefix + name} open className="note-folder">
            <summary>
              <Folder size={14} />
              <span>
                {basePath && !prefix
                  ? { Cards: "知识卡", Journal: "学习记录", Assets: "附件" }[
                      name
                    ] || name
                  : name}
              </span>
            </summary>
            <div>{render(child, prefix + name + "/")}</div>
          </details>
        ))}
    </>
  );
  return render(root);
}
