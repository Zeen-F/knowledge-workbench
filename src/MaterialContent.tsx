import type { Capture } from "../shared/contracts";
import { assetUrl, renderMarkdown } from "./markdown";
import { materialKindLabel } from "./materials";
import { shortDate } from "./client";

/** A read-only snapshot: links are shown as text, never navigate the editor. */
export function SnapshotText({ text, path }: { text: string; path: string }) {
  return (
    <div
      className="markdown-preview material-body"
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(text, path, { inertLinks: true }),
      }}
    />
  );
}

export function MaterialContent({ capture }: { capture: Capture }) {
  return (
    <>
      <p className="material-meta">
        {materialKindLabel(capture.ref.kind)} ·{" "}
        {shortDate(capture.ref.capturedAt)}
      </p>
      {capture.ref.paperdesk && (
        <p className="material-provenance">
          {capture.ref.paperdesk.title} · PDF 第 {capture.ref.paperdesk.page} 页
        </p>
      )}
      {capture.ref.assetPath && (
        <img
          className="material-image"
          src={assetUrl(capture.ref.assetPath)}
          alt={capture.ref.title}
        />
      )}
      <SnapshotText text={capture.text} path={capture.path} />
    </>
  );
}
