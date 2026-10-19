import type { Capture, Job, Proposal } from "../shared/contracts";

export type MaterialKind = "all" | Capture["ref"]["kind"];
export const materialKindLabel = (kind: Capture["ref"]["kind"]) =>
  ({ paperdesk: "来自纸间", image: "截图与图片", text: "手写想法" })[kind];

export function filterMaterials(
  captures: Capture[],
  query: string,
  kind: MaterialKind,
  selectedOnly: boolean,
  selected: readonly string[],
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const ids = new Set(selected);
  return captures.filter((capture) => {
    if (kind !== "all" && capture.ref.kind !== kind) return false;
    if (selectedOnly && !ids.has(capture.id)) return false;
    const searchable = [
      capture.ref.title,
      capture.text,
      capture.path,
      capture.ref.paperdesk?.title,
      capture.ref.paperdesk?.quote,
    ]
      .filter(Boolean)
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

export function reviewEvidence(proposal: Proposal, job?: Job) {
  const ids = new Set(proposal.sourceIds);
  const sources = job?.snapshot.sources.filter((s) => ids.has(s.id)) || [];
  const available = new Set(sources.map((s) => s.id));
  return {
    sources,
    references: job?.snapshot.references || [],
    missing: [...ids].filter((id) => !available.has(id)),
  };
}
