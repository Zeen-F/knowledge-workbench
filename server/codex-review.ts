import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexOptions } from "../shared/codex-options.ts";
import { AppError } from "./files.ts";

export type ReviewTurnProgress = { turnId?: string; text: string };
type LiveReview = {
  requestId: string;
  previous?: ReviewTurnProgress;
  onDispatch: () => void;
  onProgress: (progress: ReviewTurnProgress) => void;
};
export type ReviewConversation = {
  workspace: string;
  threadId?: string;
  onThread: (id: string) => void;
  live?: LiveReview;
};

const timeoutMs = 15000;
const maxAnswer = 2_000_000;
const maxFrame = 12 * 1024 * 1024;
const runnerArgs = [
  "app-server",
  "--listen",
  "stdio://",
  ...[
    "apps",
    "plugins",
    "remote_plugin",
    "hooks",
    "memories",
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "multi_agent_v2",
    "browser_use",
    "browser_use_external",
    "code_mode",
    "code_mode_only",
    "skill_mcp_dependency_install",
    "skill_env_var_dependency_prompt",
  ].flatMap((feature) => ["--disable", feature]),
  "-c",
  'web_search="disabled"',
  "-c",
  'approval_policy="never"',
  "-c",
  'sandbox_mode="read-only"',
  "-c",
  'shell_environment_policy.inherit="none"',
  "-c",
  "orchestrator.mcp.enabled=false",
  "-c",
  "cloud.skills.enabled=false",
  "-c",
  "project_doc_max_bytes=0",
];

function connectionError() {
  return new AppError("本机 Codex 连接已中断。可核对这一轮的结果。", 502);
}

class CodexStdio {
  private child: ChildProcessWithoutNullStreams;
  private exited: Promise<void>;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  closed = false;
  onClose?: (error: Error) => void;
  onEvent?: (method: string, params: any) => void;

  constructor(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    disabled: string[],
    fast = false,
  ) {
    this.child = spawn(
      command,
      [
        ...runnerArgs,
        ...(fast ? ["--enable", "fast_mode"] : []),
        ...disabled.flatMap((name) => [
          "-c",
          "mcp_servers." + name + ".enabled=false",
        ]),
      ],
      { cwd, env, stdio: "pipe", windowsHide: true },
    );
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (this.closed) return;
      if (line.length > maxFrame) return this.close();
      try {
        const message = JSON.parse(line);
        if (typeof message.method === "string") {
          if (message.id !== undefined) {
            this.send({
              id: message.id,
              error: { code: -32601, message: "Unavailable" },
            });
          } else this.onEvent?.(message.method, message.params);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error || !Object.hasOwn(message, "result")) {
          pending.reject(
            new AppError("Codex 未能完成本次请求。可核对登录与运行设置。", 502),
          );
        } else pending.resolve(message.result);
      } catch {
        this.close();
      }
    });
    this.child.once("error", () => this.close());
    this.child.once("exit", () => this.close());
    this.child.stdin.once("error", () => this.close());
  }

  private send(message: object) {
    if (this.closed) throw connectionError();
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "knowledge-workbench",
        title: "Knowledge Workbench",
        version: "0.1",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  request(method: string, params: object): Promise<any> {
    if (this.closed) return Promise.reject(connectionError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(connectionError());
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const error = connectionError();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose?.(error);
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill(), 800);
    const force = setTimeout(() => this.child.kill("SIGKILL"), 2500);
    void this.exited.then(() => {
      clearTimeout(terminate);
      clearTimeout(force);
    });
  }

  async dispose() {
    this.close();
    await this.exited;
  }
}

async function inheritedTools(client: CodexStdio, cwd: string) {
  const result = await client.request("config/read", {
    cwd,
    includeLayers: false,
  });
  if (!result?.config || typeof result.config !== "object")
    throw connectionError();
  const entries = Object.entries<{ enabled?: boolean }>(
    result.config.mcp_servers ?? {},
  );
  const enabled = entries.filter(([, settings]) => settings?.enabled !== false);
  const names = enabled.map(([name]) => name);
  if (names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
    throw connectionError();
  return names;
}

type RemoteItem = {
  id: string;
  type: string;
  text?: string;
  content?: { text?: string }[];
};
type RemoteTurn = { id: string; status: string; items?: RemoteItem[] };
const itemText = (item: RemoteItem) =>
  item.type === "agentMessage" && typeof item.text === "string"
    ? item.text
    : "";

async function recoverTurn(
  client: CodexStdio,
  threadId: string,
  marker: string,
  turnId?: string,
) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const turns: RemoteTurn[] = result?.thread?.turns;
  if (result?.thread?.id !== threadId || !Array.isArray(turns))
    throw connectionError();
  const turn = turns.findLast((entry) =>
    turnId
      ? entry.id === turnId
      : entry.items?.some(
          (item) =>
            item.type === "userMessage" &&
            item.content?.some((content) =>
              content.text?.startsWith(marker + "\n"),
            ),
        ),
  );
  if (turn?.status === "completed") {
    const text = (turn.items || []).map(itemText).filter(Boolean).at(-1);
    if (text) return { turnId: turn.id, text };
  }
  if (turn?.status !== "failed" && turn?.status !== "interrupted")
    throw new AppError(
      "本轮的发送结果尚未确认。原消息已保留，请稍后核对。",
      409,
    );
}

export async function runCodexReview(
  command: string,
  env: NodeJS.ProcessEnv,
  conversation: ReviewConversation & { live: LiveReview },
  instructions: string,
  prompt: string,
  imagePaths: string[],
  options: CodexOptions | undefined,
  signal?: AbortSignal,
) {
  const { workspace: cwd, live } = conversation;
  signal?.throwIfAborted();
  let client = new CodexStdio(command, cwd, env, [], options?.fast);
  let interrupt: (() => void) | undefined;
  let stopTimeout: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (interrupt) {
      interrupt();
      stopTimeout = setTimeout(() => client.close(), 5500);
    } else client.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.initialize();
    const tools = await inheritedTools(client, cwd);
    if (tools.length) {
      await client.dispose();
      signal?.throwIfAborted();
      client = new CodexStdio(command, cwd, env, tools, options?.fast);
      await client.initialize();
      if ((await inheritedTools(client, cwd)).length) throw connectionError();
    }
    const target = conversation.threadId;
    const { thread, sandbox, approvalPolicy } = await client.request(
      target ? "thread/resume" : "thread/start",
      {
        cwd,
        developerInstructions: instructions,
        sandbox: "read-only",
        approvalPolicy: "never",
        ...(target ? { threadId: target, excludeTurns: true } : {}),
      },
    );
    const threadId = thread?.id;
    if (
      typeof threadId !== "string" ||
      !threadId ||
      (target && threadId !== target) ||
      sandbox?.type !== "readOnly" ||
      sandbox?.networkAccess === true ||
      approvalPolicy !== "never"
    )
      throw new AppError("Codex 未能核对当前会话的身份和权限。", 502);
    conversation.onThread(threadId);
    const marker = "知识工作台消息 " + live.requestId;
    if (live.previous) {
      const recovered = await recoverTurn(
        client,
        threadId,
        marker,
        live.previous.turnId,
      );
      if (recovered) {
        live.onProgress(recovered);
        return recovered.text;
      }
    }
    signal?.throwIfAborted();
    const items = new Map<string, string>();
    let turnId: string | undefined;
    let text = "";
    let stopSent = false;
    let lastUpdate = 0;
    const update = (force = false) => {
      if (!force && Date.now() - lastUpdate < 160) return;
      lastUpdate = Date.now();
      live.onProgress({ turnId, text });
    };
    interrupt = () => {
      if (!turnId || stopSent) return;
      stopSent = true;
      void client
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => client.close());
    };
    function bindTurn(id: string) {
      if (typeof id !== "string" || !id || (turnId && turnId !== id)) return;
      if (!turnId) {
        turnId = id;
        update(true);
      }
      if (signal?.aborted) interrupt?.();
    }
    const finished = new Promise<RemoteTurn>((resolve, reject) => {
      client.onClose = reject;
      client.onEvent = (method, params) => {
        if (params?.threadId !== threadId) return;
        if (method === "turn/started") bindTurn(params.turn?.id);
        if (method === "turn/completed") {
          if (params.turn?.id && (!turnId || params.turn.id === turnId)) {
            bindTurn(params.turn.id);
            resolve(params.turn);
          }
          return;
        }
        if (!turnId || params.turnId !== turnId) return;
        if (
          method === "item/agentMessage/delta" &&
          typeof params.delta === "string"
        ) {
          const earlier = items.get(params.itemId) || "";
          text = (earlier + params.delta).slice(0, maxAnswer);
          items.set(params.itemId, text);
          update(!earlier);
        }
        if (method === "item/completed" && params.item) {
          const result = itemText(params.item);
          if (result) {
            text = result.slice(0, maxAnswer);
            items.set(params.item.id, text);
            update(true);
          }
        }
      };
    });
    void finished.catch(() => {});
    const timer = setTimeout(() => {
      interrupt?.();
      client.close();
    }, 600000);
    try {
      live.onDispatch();
      const started = await client.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: marker + "\n\n" + prompt, text_elements: [] },
          ...imagePaths.map((file) => ({ type: "localImage", path: file })),
        ],
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.effort ? { effort: options.effort } : {}),
        ...(options
          ? { serviceTier: options.fast ? "priority" : "default" }
          : {}),
        environments: [],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      if (typeof started?.turn?.id !== "string") throw connectionError();
      bindTurn(started.turn.id);
      const completed = await finished;
      text = (
        (completed.items || []).map(itemText).filter(Boolean).at(-1) || text
      ).slice(0, maxAnswer);
      update(true);
      signal?.throwIfAborted();
      if (completed.status !== "completed" || !text.trim())
        throw new AppError("Codex 未完成本轮回复。可核对后重试。", 502);
      return text.trim();
    } finally {
      clearTimeout(timer);
      update(true);
    }
  } finally {
    clearTimeout(stopTimeout);
    signal?.removeEventListener("abort", abort);
    await client.dispose();
  }
}
