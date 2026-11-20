import fs from "node:fs";
import path from "node:path";
import type {
  NoteAnnotation,
  NoteImage,
  NoteImageIssue,
  NoteReference,
} from "../shared/contracts.ts";
import { markdownLinks } from "../shared/markdown-links.ts";
import { localLinkTarget, normalizeNotePath } from "../shared/note-links.ts";
import { AppError, detectImage, digest } from "./files.ts";
import type { ModelImages } from "./provider.ts";
import type { Vault } from "./vault.ts";

const imageTypes = /\.(png|jpe?g|webp)$/i;
const maxImage = 20 * 1024 * 1024;
const maxImages = 48 * 1024 * 1024;
const authorRequest =
  /[？?]|\b(?:todo|fixme)\b|为什么|怎么(?:算|求|推|解释|理解|处理|分析)|如何|给我|帮我|我希望|我想(?:让|请|要)|请(?:帮|补|分析|解|推|整理|查|对照|说明)|待(?:解释|推导|补|分析)|(?:推导|分析|总结|汇总|解释|对比|查找)(?:过程|一下|一遍)?[）)。！!]*$|(?:补|开|拆成|整理成)(?:一[篇份]|一些|几个)?子笔记/i;

function findAnnotations(content: string, images: NoteImage[]) {
  const annotations: NoteAnnotation[] = [];
  let fence: string | undefined;
  for (const [index, value] of content.split(/\r?\n/).entries()) {
    const text = value.trim();
    const delimiter = text.match(/^(\u0060{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length
      )
        fence = undefined;
      continue;
    }
    if (
      fence ||
      !text ||
      /^(?:!\[|https?:\/\/|<!--|#{1,6}\s)/i.test(text) ||
      (/^>/.test(text) && !/\[!todo\]|\bTODO\b/i.test(text))
    )
      continue;
    if (
      !/^\s*[-*+]\s+\[ \]/.test(value) &&
      !authorRequest.test(text.replace(/https?:\/\/\S+/gi, ""))
    )
      continue;
    const line = index + 1;
    const previous = images.findLastIndex((image) => image.line <= line);
    annotations.push({
      line,
      text: text.slice(0, 1200),
      ...(previous >= 0 ? { nearbyImage: previous + 1 } : {}),
    });
    if (annotations.length === 80) break;
  }
  return annotations;
}

function readImage(vault: Vault, relative: string) {
  const file = vault.absolute(relative);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maxImage)
    throw new AppError("图片超过大小限制或无法读取");
  const bytes = fs.readFileSync(file);
  return { bytes, mime: detectImage(bytes).mime };
}

export function noteOptimizationContext(vault: Vault, note: NoteReference) {
  const images: NoteImage[] = [];
  const imageIssues: NoteImageIssue[] = [];
  let totalBytes = 0;
  for (const link of markdownLinks(note.content)) {
    if (link.imageAt === undefined) continue;
    // Embeds of other Markdown notes remain links; only local image bytes
    // explicitly shown during the confirmation preview are attached.
    const target = localLinkTarget(link.target, note.path, link.style);
    if (
      link.style === "wiki" &&
      !/\.(png|jpe?g|webp|gif|svg|avif|heic)$/i.test(link.target)
    )
      continue;
    const line = note.content.slice(0, link.imageAt).split(/\r?\n/).length;
    if (!target || !imageTypes.test(target)) {
      imageIssues.push({
        line,
        detail: "图片需要是知识库内的 PNG、JPEG 或 WebP 文件",
      });
      continue;
    }
    const choices =
      link.style === "wiki"
        ? [
            normalizeNotePath(target),
            normalizeNotePath(path.posix.dirname(note.path) + "/" + target),
          ]
        : [target];
    let loaded: { relative: string; bytes: Buffer; mime: string } | undefined;
    for (const relative of new Set(choices)) {
      if (!relative) continue;
      try {
        loaded = { relative, ...readImage(vault, relative) };
        break;
      } catch {
        /* A missing or unavailable attachment stays visible in the preview. */
      }
    }
    if (!loaded) {
      imageIssues.push({
        line,
        detail: "本机图片无法读取，或单张图片超过 20 MiB",
      });
      continue;
    }
    if (images.length >= 48 || totalBytes + loaded.bytes.length > maxImages) {
      imageIssues.push({ line, detail: "超过本次可发送的图片数量或总大小" });
      continue;
    }
    totalBytes += loaded.bytes.length;
    images.push({
      path: loaded.relative,
      line,
      mime: loaded.mime,
      hash: digest(loaded.bytes),
    });
  }
  images.sort((a, b) => a.line - b.line);
  return {
    images,
    imageIssues,
    annotations: findAnnotations(note.content, images),
  };
}

export function optimizationImages(
  vault: Vault,
  images: NoteImage[],
): ModelImages {
  return images.map((image) => {
    try {
      const { bytes, mime } = readImage(vault, image.path);
      if (mime === image.mime && digest(bytes) === image.hash)
        return { mime, data: bytes.toString("base64") };
    } catch {
      /* Do not substitute a different image for the confirmed version. */
    }
    throw new AppError(
      "正文第 " + image.line + " 行的图片已变化或不可读，请重新预览。",
      409,
    );
  });
}
