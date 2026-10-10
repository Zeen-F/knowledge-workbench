import fs from "node:fs";
import path from "node:path";
import {
  recoveryIdentitySchema,
  recoveryRecordSchema,
  type RecoveryRecord,
  type StoredRecovery,
} from "../shared/recovery.ts";
import { AppError, atomicWrite, digest, readUtf8 } from "./files.ts";

// Recovery belongs to the current vault's external profile, never to notes or model tools.
export class RecoveryStore {
  constructor(readonly directory: string) {}
  private file(identity: { kind: string; id: string }) {
    const parsed = recoveryIdentitySchema.parse(identity);
    return path.join(
      this.directory,
      digest(parsed.kind + ":" + parsed.id) + ".json",
    );
  }
  private read(file: string): StoredRecovery | null {
    let text: string;
    try {
      text = readUtf8(file);
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const record = recoveryRecordSchema.parse(JSON.parse(text));
    if (this.file(record) !== file)
      throw new AppError("恢复草稿身份不匹配，请保留文件并检查", 409);
    return { record, hash: digest(text) };
  }
  list() {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .map((n) => this.read(path.join(this.directory, n)))
      .filter((r): r is StoredRecovery => r !== null);
  }
  save(input: RecoveryRecord, expectedHash: string | null) {
    const record = recoveryRecordSchema.parse(input),
      file = this.file(record),
      text = JSON.stringify(record);
    const current = this.read(file),
      hash = digest(text);
    if (current?.hash === hash) return current; // Retry after a lost acknowledgement.
    if ((current?.hash || null) !== expectedHash)
      throw new AppError(
        "恢复草稿已在其他窗口修改，当前输入仍保留，请勿关闭面板。",
        409,
        "RECOVERY_CONFLICT",
      );
    atomicWrite(file, text);
    return { record, hash };
  }
  clear(identity: { kind: string; id: string }, expectedHash: string | null) {
    const file = this.file(identity),
      current = this.read(file);
    if (!current) return;
    if (current.hash !== expectedHash)
      throw new AppError(
        "恢复草稿已有更新，未清除新输入。",
        409,
        "RECOVERY_CONFLICT",
      );
    fs.unlinkSync(file);
  }
}
