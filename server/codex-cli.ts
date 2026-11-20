import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { CodexCliStatus } from "../shared/contracts.ts";
import {
  codexModelSchema,
  reasoningEffortSchema,
  type CodexCatalog,
  type CodexOptions,
} from "../shared/codex-options.ts";
import type { ResearchProfileSnapshot } from "../shared/research-profiles.ts";
import { AppError, atomicWrite, readUtf8 } from "./files.ts";
import { organizingInstructions, type ModelImages } from "./provider.ts";
import { runCodexReview, type ReviewConversation } from "./codex-review.ts";

function cliDirectories() {
  return [
    ...new Set([
      ...(process.env.PATH || "")
        .split(path.delimiter)
        .filter((entry) => path.isAbsolute(entry)),
      path.join(os.homedir(), ".local", "bin"),
      ...(process.platform === "win32"
        ? []
        : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
    ]),
  ];
}
function cliEnvironment() {
  // Desktop API configuration must not redirect the user's CLI account.
  const { OPENAI_API_KEY, CODEX_API_KEY, OPENAI_BASE_URL, ...env } =
    process.env;
  return { ...env, PATH: cliDirectories().join(path.delimiter) };
}

function cliExecutable() {
  const onWindows = process.platform === "win32";
  const name = onWindows ? "codex.exe" : "codex";
  const npmVendor = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming"),
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
  );
  const override = process.env.KWB_CODEX_CLI;
  const candidates = override
    ? [override]
    : [
        ...cliDirectories().map((directory) => path.join(directory, name)),
        ...(onWindows
          ? ["x64", "arm64"].flatMap((arch) =>
              ["bin", "codex"].map((folder) =>
                path.join(
                  npmVendor,
                  `codex-win32-${arch}`,
                  "vendor",
                  arch === "x64"
                    ? "x86_64-pc-windows-msvc"
                    : "aarch64-pc-windows-msvc",
                  folder,
                  name,
                ),
              ),
            )
          : ["/Applications/Codex.app/Contents/Resources/codex"]),
      ];
  return candidates.find((file) => {
    try {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) return false;
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function execute(
  executable: string,
  args: string[],
  cwd: string,
  timeout: number,
  input?: string,
  signal?: AbortSignal,
  onThread?: (threadId: string) => void,
) {
  return new Promise<string>((resolve, reject) => {
    let eventError: unknown;
    const child = execFile(
      executable,
      args,
      {
        cwd,
        timeout,
        signal,
        env: cliEnvironment(),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (eventError) reject(eventError);
        else if (error)
          reject(
            Object.assign(error, { statusOutput: stdout + "\n" + stderr }),
          );
        else resolve(stdout + "\n" + stderr);
      },
    );
    if (onThread && child.stdout)
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (eventError) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (
          event?.type !== "thread.started" ||
          !z.string().uuid().safeParse(event.thread_id).success
        )
          return;
        try {
          onThread(event.thread_id);
        } catch (error) {
          eventError = error;
          child.kill();
        }
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export async function codexCliStatus(): Promise<CodexCliStatus> {
  const executable = cliExecutable();
  if (!executable) return "missing";
  try {
    const result = await execute(
      executable,
      ["login", "status"],
      os.tmpdir(),
      5000,
    );
    return /\bLogged in\b/i.test(result) ? "ready" : "unavailable";
  } catch (error) {
    const output = (error as { statusOutput?: string }).statusOutput || "";
    return /\bNot logged in\b/i.test(output) ? "signed-out" : "unavailable";
  }
}

const appServerModel = z.object({
  model: codexModelSchema,
  displayName: z.string().optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z
    .array(z.object({ reasoningEffort: z.string() }))
    .default([]),
  defaultReasoningEffort: z.string().optional(),
  serviceTiers: z.array(z.object({ id: z.string() })).default([]),
  additionalSpeedTiers: z.array(z.string()).default([]),
});
const isFastTier = (tier: string | undefined) =>
  tier === "priority" || tier === "fast";

export async function codexCliCatalog(): Promise<CodexCatalog | undefined> {
  const executable = cliExecutable();
  if (!executable) return undefined;
  return new Promise((resolve) => {
    // Same public app-server catalog used by XiReader. This process never
    // starts a model turn and receives no material from the vault.
    const child = spawn(
      executable,
      [
        "app-server",
        "--listen",
        "stdio://",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "-c",
        "mcp_servers={}",
      ],
      {
        cwd: os.tmpdir(),
        env: cliEnvironment(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const lines = createInterface({ input: child.stdout });
    const models = new Map<string, CodexCatalog["models"][number]>();
    let defaultModel: string | undefined;
    let config: {
      model?: string;
      model_reasoning_effort?: string;
      service_tier?: string;
    } = {};
    let finished = false;
    let pages = 0;
    let configReady = false;
    let modelsReady = false;
    const finish = (catalog?: CodexCatalog) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && !child.killed) child.kill();
      resolve(catalog);
    };
    const timeout = setTimeout(() => finish(), 8500);
    const send = (message: object) =>
      child.stdin.write(JSON.stringify(message) + "\n");
    child.once("error", () => finish());
    child.once("exit", () => finish());
    child.stdin.once("error", () => finish());
    lines.on("line", (line) => {
      if (line.length > 2_000_000) return finish();
      try {
        const message = JSON.parse(line);
        if (message.id === 0) {
          if (message.error) return finish();
          send({ method: "initialized" });
          send({
            id: 1,
            method: "model/list",
            params: { limit: 100, includeHidden: false },
          });
          send({
            id: 2,
            method: "config/read",
            params: { includeLayers: false },
          });
        } else if (message.id === 1) {
          if (!Array.isArray(message.result?.data)) return finish();
          for (const value of message.result.data) {
            const parsed = appServerModel.safeParse(value);
            if (!parsed.success || parsed.data.hidden) continue;
            const m = parsed.data;
            const efforts = reasoningEffortSchema.options.filter((effort) =>
              m.supportedReasoningEfforts.some(
                (option) => option.reasoningEffort === effort,
              ),
            );
            models.set(m.model, {
              id: m.model,
              name: m.displayName?.slice(0, 120) || m.model,
              efforts,
              defaultEffort: efforts.find(
                (effort) => effort === m.defaultReasoningEffort,
              ),
              supportsFast:
                m.serviceTiers.some((tier) => isFastTier(tier.id)) ||
                m.additionalSpeedTiers.includes("fast"),
            });
            if (m.isDefault) defaultModel = m.model;
          }
          const cursor = message.result.nextCursor;
          if (typeof cursor === "string" && cursor && ++pages < 5)
            send({
              id: 1,
              method: "model/list",
              params: { limit: 100, includeHidden: false, cursor },
            });
          else modelsReady = true;
        } else if (message.id === 2) {
          config = message.result?.config || {};
          configReady = true;
        }
        if (modelsReady && configReady) {
          if (!models.size) return finish();
          const preferred =
            models.get(config.model || "") ||
            models.get(defaultModel || "") ||
            models.values().next().value!;
          const effort =
            preferred.efforts.find(
              (option) => option === config.model_reasoning_effort,
            ) || preferred.defaultEffort;
          finish({
            models: [...models.values()],
            defaults: {
              model: preferred.id,
              effort,
              fast: preferred.supportsFast && isFastTier(config.service_tier),
            },
          });
        }
      } catch {
        finish();
      }
    });
    send({
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "knowledge-workbench", version: "0.1" } },
    });
  });
}

export async function callCodexCli(
  prompt: string,
  images: ModelImages = [],
  signal?: AbortSignal,
  profile?: ResearchProfileSnapshot,
  options?: CodexOptions,
  conversation?: ReviewConversation,
) {
  const executable = cliExecutable();
  if (!executable)
    throw new AppError(
      "未找到本机 Codex CLI，可安装并登录 Codex，或在整理时选择模型 API。",
      409,
    );
  signal?.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kwb-codex-"));
  const workspace = conversation?.workspace || directory;
  const output = path.join(directory, "response.txt");
  try {
    const runtimeDir =
      typeof __dirname === "string"
        ? __dirname
        : path.join(process.cwd(), "server");
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const guide = readUtf8(
      path.join(runtimeDir, "../desktop/codex-workspace/AGENTS.md"),
    );
    atomicWrite(path.join(workspace, "AGENTS.md"), guide);
    const instruction = organizingInstructions(profile);
    const imagePaths = images.map(({ data, mime }, index) => {
      const extension =
        mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
      const image = path.join(directory, `image-${index + 1}.${extension}`);
      fs.writeFileSync(image, Buffer.from(data, "base64"), { mode: 0o600 });
      return image;
    });
    if (conversation?.live)
      return await runCodexReview(
        executable,
        cliEnvironment(),
        { ...conversation, live: conversation.live },
        guide + "\n\n" + instruction,
        prompt,
        imagePaths,
        options,
        signal,
      );
    const args = [
      "exec",
      "--cd",
      workspace,
      "--skip-git-repo-check",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--disable",
      "shell_tool",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "multi_agent_v2",
      "-c",
      'web_search="disabled"',
      "-c",
      'approval_policy="never"',
      "--color",
      "never",
      "--output-last-message",
      output,
    ];
    if (options?.model) args.push("--model", options.model);
    if (options?.effort)
      args.push(
        "-c",
        "model_reasoning_effort=" + JSON.stringify(options.effort),
      );
    if (options)
      args.push(
        "-c",
        'service_tier="' + (options.fast ? "priority" : "default") + '"',
      );
    if (options?.fast) args.push("--enable", "fast_mode");
    for (const image of imagePaths) args.push("--image", image);
    try {
      await execute(
        executable,
        conversation?.threadId
          ? [...args, "resume", conversation.threadId, "-"]
          : [...args, "--", "-"],
        workspace,
        options || images.length > 1 ? 600000 : 180000,
        `${instruction}\n\n${prompt}`,
        signal,
        conversation?.onThread,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError) throw error;
      if (
        conversation?.threadId &&
        /no (?:existing )?session found|no rollout found|thread not found/i.test(
          String((error as { statusOutput?: string }).statusOutput || ""),
        )
      )
        throw new AppError(
          "本机 Codex 找不到原会话。已保存的修改意见可以在工作台对话记录中查看。",
          409,
          "CODEX_SESSION_MISSING",
        );
      throw new AppError(
        "本机 Codex CLI 未完成整理，请检查登录状态和连接后重试，或选择模型 API。",
        502,
        "CODEX_CLI_FAILED",
      );
    }
    const result = fs.existsSync(output) && readUtf8(output).trim();
    if (!result) throw new AppError("本机 Codex CLI 没有返回可用文字", 502);
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
