import YAML from "yaml";
import type { Capture } from "../shared/contracts";
import { assetUrl, renderMarkdown } from "./markdown";
import { materialKindLabel } from "./materials";
import { shortDate } from "./client";

/** A read-only snapshot: links are shown as text, never navigate the editor. */
export function SnapshotText({ text, path }: { text: string; path: string }) {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata: string | undefined;
  if (match) {
    try {
      const value: unknown = YAML.parse(match[1], { maxAliasCount: 50 });
      if (
        value === null ||
        (typeof value === "object" && !Array.isArray(value))
      )
        metadata = match[0];
    } catch {
      /* Invalid properties remain visible in the source body. */
    }
  }
  const body = metadata ? text.slice(metadata.length) : text;
  return (
    <>
      {metadata && (
        <details className="snapshot-metadata">
          <summary>笔记属性（原始快照）</summary>
          <pre>{metadata}</pre>
        </details>
      )}
      <div
        className="markdown-preview material-body"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(body, path, { inertLinks: true }),
        }}
      />
    </>
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
