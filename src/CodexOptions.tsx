import {
  reasoningEffortSchema,
  type CodexCatalog,
  type CodexOptions,
  type ReasoningEffort,
} from "../shared/codex-options";

const effortLabel: Record<ReasoningEffort, string> = {
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "Ultra",
};

export function CodexOptionsFields({
  catalog,
  value,
  disabled,
  onChange,
}: {
  catalog?: CodexCatalog;
  value: CodexOptions;
  disabled?: boolean;
  onChange: (options: CodexOptions) => void;
}) {
  const model = catalog?.models.find((item) => item.id === value.model);
  const efforts = model?.efforts ?? reasoningEffortSchema.options;
  return (
    <fieldset className="codex-options" disabled={disabled}>
      <legend>Codex CLI 运行设置</legend>
      <div className="codex-options-fields">
        <label>
          模型
          {catalog ? (
            <select
              value={value.model ?? ""}
              onChange={(event) => {
                const next = catalog.models.find(
                  (item) => item.id === event.target.value,
                );
                if (!next) return;
                onChange({
                  model: next.id,
                  effort:
                    value.effort && next.efforts.includes(value.effort)
                      ? value.effort
                      : next.defaultEffort,
                  fast: value.fast && next.supportsFast,
                });
              }}
            >
              {!model && (
                <option value={value.model ?? ""}>
                  {value.model ?? "CLI 默认"}
                </option>
              )}
              {catalog.models.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={value.model || ""}
              placeholder="CLI 默认，或填入模型 ID"
              maxLength={120}
              onChange={(event) =>
                onChange({
                  ...value,
                  model: event.target.value.trim() || undefined,
                })
              }
            />
          )}
        </label>
        <label>
          思考强度
          <select
            value={value.effort ?? ""}
            onChange={(event) => {
              const effort = reasoningEffortSchema.safeParse(
                event.target.value,
              );
              onChange({
                ...value,
                effort: effort.success ? effort.data : undefined,
              });
            }}
          >
            <option value="">模型默认</option>
            {efforts.map((effort) => (
              <option value={effort} key={effort}>
                {effortLabel[effort]}（{effort}）
              </option>
            ))}
          </select>
        </label>
        <label className="codex-fast-option">
          <input
            type="checkbox"
            checked={value.fast}
            disabled={model?.supportsFast === false}
            onChange={(event) =>
              onChange({ ...value, fast: event.target.checked })
            }
          />
          Fast 模式
        </label>
      </div>
    </fieldset>
  );
}

export function CodexOptionsSummary({
  value,
  catalog,
}: {
  value: CodexOptions;
  catalog?: CodexCatalog;
}) {
  const model = catalog?.models.find((item) => item.id === value.model);
  return (
    <p className="muted">
      {model?.name || value.model || "CLI 默认模型"} ·{" "}
      {value.effort
        ? effortLabel[value.effort] + "（" + value.effort + "）"
        : "默认思考强度"}{" "}
      · Fast {value.fast ? "开启" : "关闭"}
    </p>
  );
}
