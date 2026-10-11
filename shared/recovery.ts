import { z } from "zod";
import { hashSchema } from "./contracts";

export const recoveryIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox"), id: z.literal("") }),
  z.object({ kind: z.literal("review"), id: z.string().uuid() }),
]);
export const recoveryRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inbox"),
    id: z.literal(""),
    value: z.object({
      title: z.string().max(200),
      thought: z.string().max(500000),
      requestId: z.string().uuid(),
    }),
  }),
  z.object({
    kind: z.literal("review"),
    id: z.string().uuid(),
    value: z.object({ text: z.string().max(2000000), hash: hashSchema }),
  }),
]);
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
export type StoredRecovery = { record: RecoveryRecord; hash: string };

export const SERVICE_FEATURES = {
  reliability: 1,
  recovery: 1,
  researchProfiles: 1,
} as const;
export function requirePanelFeatures(status: {
  features?: Record<string, number>;
}) {
  if (
    Object.entries(SERVICE_FEATURES).some(
      ([key, version]) => (status.features?.[key] || 0) < version,
    )
  )
    throw Object.assign(
      new Error(
        "桌面服务版本较旧，请先更新知识工作台桌面服务，再重新打开此面板。仅更新插件不会启用可靠性优化。",
      ),
      { code: "SERVICE_UPGRADE_REQUIRED", status: 409 },
    );
}
