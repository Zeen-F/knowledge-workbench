import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { relativePathSchema } from "../shared/contracts.ts";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(
    message: string,
    status = 400,
    code = "INVALID",
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const now = () => new Date().toISOString();
export const portable = (value: string) => value.split(path.sep).join("/");
export const inside = (root: string, candidate: string) => {
  const rel = path.relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
};

export function safePath(root: string, relative: string): string {
  relativePathSchema.parse(relative);
  if (relative.split("/").some((s) => /^(\.obsidian|\.git|\.trash)$/i.test(s)))
    throw new AppError("此位置不属于可编辑的知识内容");
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new AppError("路径超出知识库");
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new AppError("无法确定文件位置");
    cursor = parent;
  }
  if (!inside(root, fs.realpathSync(cursor)))
    throw new AppError("链接指向知识库之外");
  return target;
}
export function readUtf8(file: string): string {
  const size = fs.statSync(file).size;
  if (size > 8 * 1024 * 1024)
    throw new AppError("该笔记超过 8 MiB，请在其他编辑器中分拆后重试", 413);
  const raw = fs.readFileSync(file);
  const decoded = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(raw);
  return decoded;
}
export function atomicWrite(
  file: string,
  data: string | Buffer,
  exclusive = false,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      fs.linkSync(tmp, file);
      fs.unlinkSync(tmp);
    } else fs.renameSync(tmp, file);
    if (
      digest(fs.readFileSync(file)) !==
      digest(Buffer.isBuffer(data) ? data : Buffer.from(data))
    )
      throw new AppError("写入后的文件校验不一致", 500, "SAVE_UNCONFIRMED");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export const slug = (s: string) =>
  s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 85)
    .trim() || "未命名";
export function detectImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new AppError("图片必须小于 20 MiB", 413);
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png" as const, ext: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { mime: "image/jpeg" as const, ext: "jpg" };
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return { mime: "image/webp" as const, ext: "webp" };
  throw new AppError("仅支持 PNG、JPEG 和 WebP 图片");
}
export function decodeBase64(value: string) {
  if (typeof value !== "string" || value.length > 28 * 1024 * 1024)
    throw new AppError("图片数据过大", 413);
  const encoded = value.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new AppError("图片编码无效");
  detectImage(bytes);
  return bytes;
}
