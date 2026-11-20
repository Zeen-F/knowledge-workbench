import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Note } from "../shared/contracts";
import { renderMarkdown } from "./markdown";

export type LoadLinkPreview = (
  href: string,
) => Promise<Pick<Note, "title" | "path" | "body"> | undefined>;

export function EditorLinkPreview({
  surface,
  load,
}: {
  surface: RefObject<HTMLDivElement | null>;
  load?: LoadLinkPreview;
}) {
  const currentLoad = useRef(load);
  currentLoad.current = load;
  const enabled = Boolean(load);
  const card = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<{
    title: string;
    html: string;
    left: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !surface.current) return;
    const editor = surface.current;
    let active: { link: HTMLAnchorElement } | null = null;
    let loading: ReturnType<typeof setTimeout> | undefined;
    let leaving: ReturnType<typeof setTimeout> | undefined;
    let displayed = false;

    function close() {
      active = null;
      clearTimeout(loading);
      clearTimeout(leaving);
      if (displayed) setPreview(null);
      displayed = false;
    }
    function onOver(event: PointerEvent) {
      const element = event.target;
      if (
        event.pointerType !== "mouse" ||
        event.buttons ||
        !(element instanceof Element)
      )
        return;
      if (active?.link.contains(element) || card.current?.contains(element)) {
        clearTimeout(leaving);
        return;
      }
      const link = editor.contains(element)
        ? element.closest<HTMLAnchorElement>("a[href]")
        : null;
      if (!link) return;
      close();
      const request = (active = { link });
      loading = setTimeout(async () => {
        try {
          const note = await currentLoad.current?.(
            link.getAttribute("href") || "",
          );
          if (!note || active !== request || !link.isConnected) return;
          const rect = link.getBoundingClientRect();
          const below = window.innerHeight - rect.bottom - 16;
          const above = rect.top - 16;
          const showBelow = below >= 280 || below >= above;
          const body = note.body || "";
          const excerpt =
            body.slice(0, 5000) + (body.length > 5000 ? "\n\n…" : "");
          setPreview({
            title: note.title,
            html: renderMarkdown(excerpt, note.path, { inertLinks: true }),
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 400)),
            maxHeight: Math.min(320, showBelow ? below : above),
            ...(showBelow
              ? { top: rect.bottom + 6 }
              : { bottom: window.innerHeight - rect.top + 6 }),
          });
          displayed = true;
        } catch {
          // A note can disappear or move while the pointer rests on its link.
        }
      }, 320);
    }
    function onOut(event: PointerEvent) {
      const { target, relatedTarget } = event;
      if (
        !(target instanceof Node) ||
        !(active?.link.contains(target) || card.current?.contains(target)) ||
        (relatedTarget instanceof Node &&
          (active?.link.contains(relatedTarget) ||
            card.current?.contains(relatedTarget)))
      )
        return;
      if (!displayed) close();
      else leaving = setTimeout(close, 180);
    }
    function onActivity(event: Event) {
      if (event.target instanceof Node && card.current?.contains(event.target))
        return;
      close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", onActivity, true);
    document.addEventListener("scroll", onActivity, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      close();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", onActivity, true);
      document.removeEventListener("scroll", onActivity, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [enabled, surface]);

  if (!enabled || !preview) return null;
  const { title, html, ...position } = preview;
  return createPortal(
    <aside
      ref={card}
      className="editor-link-preview"
      aria-label="笔记预览"
      style={position}
    >
      <strong className="editor-link-preview-title">{title}</strong>
      <div
        className="markdown-preview"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </aside>,
    document.body,
  );
}
