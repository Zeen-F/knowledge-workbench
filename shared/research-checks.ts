import type { ResearchProfileSnapshot } from "./research-profiles.ts";

export type ResearchCheck = { code: string; message: string };
// Conservative, deterministic hints only. They neither grade evidence nor prove
// scientific correctness; original source text is never modified.
export function researchChecks(
  profile: ResearchProfileSnapshot | undefined,
  text: string,
): ResearchCheck[] {
  if (!profile) return [];
  const checks: ResearchCheck[] = [];
  const metrics = [
    {
      name: "R/电阻",
      pattern:
        /(?:\bR\b|电阻)\s*[=:：]\s*\d+(?:\.\d+)?(?![\d.])\s*(?=$|[，,；;。\n])/im,
    },
    {
      name: "C/电容",
      pattern:
        /(?:\bC\b|电容)\s*[=:：]\s*\d+(?:\.\d+)?(?![\d.])\s*(?=$|[，,；;。\n])/im,
    },
    {
      name: "PM/相位裕度",
      pattern:
        /(?:\bPM\b|相位裕度)\s*[=:：]\s*\d+(?:\.\d+)?(?![\d.])\s*(?=$|[，,；;。\n])/im,
    },
    {
      name: "PSRR",
      pattern:
        /\bPSRR\s*[=:：]\s*[-+]?\d+(?:\.\d+)?(?![\d.])\s*(?=$|[，,；;。\n])/im,
    },
  ];
  for (const metric of metrics)
    if (metric.pattern.test(text))
      checks.push({
        code: "MISSING_UNIT",
        message: `${metric.name} 的数值可能缺少单位，请对照原始材料核对`,
      });
  if (
    /\b(?:LDO|OTA|PMIC|ADC|PLL|SerDes)\b/i.test(text) &&
    /仿真|测量|PSRR|稳定|瞬态|噪声|simulation|measurement/i.test(text)
  ) {
    for (const [code, pattern, label] of [
      [
        "CHECK_PVT",
        /\bPVT\b|\b(?:TT|FF|SS|FS|SF)\b|工艺角|process corner/i,
        "工艺/PVT",
      ],
      ["CHECK_SUPPLY", /供电|\bV(?:DD|IN)\b|supply/i, "供电"],
      ["CHECK_TEMPERATURE", /温度|℃|°\s*C|temperature/i, "温度"],
      ["CHECK_LOAD", /负载|\bIload\b|load/i, "负载"],
    ] as const)
      if (!pattern.test(text))
        checks.push({
          code,
          message: `未识别到${label}记录；如影响此结论，请补充或标为未提供`,
        });
  }
  if (/PSRR/i.test(text) && !/频率|\b(?:[kMG]?Hz)\b|frequency/i.test(text))
    checks.push({
      code: "CHECK_FREQUENCY",
      message: "PSRR 的频率条件未识别到，请核对",
    });
  return checks;
}
