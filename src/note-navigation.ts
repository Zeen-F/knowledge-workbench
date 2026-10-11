import type { NoteSummary } from "../shared/contracts.ts";

// Navigation badges and the displayed note list must count the same records.
// Drafts remain on disk for review/history but are not formal library entries.
export function matchesNoteSection(note: NoteSummary, section: string) {
  return (
    !note.missing &&
    !note.path.includes("/Drafts/") &&
    !note.path.includes("/Inbox/") &&
    (section === "concept" || section === "learning-log"
      ? note.noteType === section
      : true)
  );
}
