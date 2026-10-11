import { ArrowUpRight, FileText } from "lucide-react";
import type { NoteSummary } from "../shared/contracts";
import { shortDate } from "./client";

// Receive the same filtered collection as the sidebar. The total and preview
// derive from that one collection, never the raw index (which includes drafts).
export function RecentNotes({
  notes,
  onOpen,
}: {
  notes: NoteSummary[];
  onOpen: (path: string) => void;
}) {
  return (
    <>
      <div className="section-label">
        <span>最近编辑</span>
        <span>{notes.length} 篇笔记</span>
      </div>
      <div className="recent-notes">
        {notes.slice(0, 7).map((note) => (
          <button key={note.path} onClick={() => onOpen(note.path)}>
            <FileText size={16} />
            <span>{note.title}</span>
            <small>{shortDate(note.updatedAt)}</small>
            <ArrowUpRight size={14} />
          </button>
        ))}
      </div>
    </>
  );
}
