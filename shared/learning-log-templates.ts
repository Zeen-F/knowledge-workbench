export const LEARNING_LOG_TEMPLATES = {
  blank: {
    label: "空白",
    headings: [],
  },
  quick: {
    label: "快速随记",
    headings: ["记下什么", "接下来要做什么"],
  },
  course: {
    label: "课程与教材",
    headings: ["学习内容与出处", "概念与例子", "疑问与练习"],
  },
  paper: {
    label: "论文精读",
    headings: [
      "文献与阅读范围",
      "研究问题与方法",
      "证据与适用条件",
      "疑问与后续阅读",
    ],
  },
  design: {
    label: "电路设计",
    headings: ["设计目标与约束", "架构与取舍", "估算与初始参数", "验证计划"],
  },
  simulation: {
    label: "仿真实验",
    headings: [
      "电路与仿真条件",
      "指标与测量方法",
      "结果与证据",
      "偏差与下一轮验证",
    ],
  },
  derivation: {
    label: "公式推导",
    headings: ["目标与已知条件", "推导过程", "量纲与适用范围"],
  },
  debug: {
    label: "调试排错",
    headings: ["现象与复现条件", "排查假设与证据", "定位、修正与复测"],
  },
  project: {
    label: "项目进展",
    headings: ["本阶段目标", "完成的工作与产物", "阻碍与待验证项", "下一步"],
  },
  review: {
    label: "复习自测",
    headings: [
      "合上资料，用自己的话解释",
      "卡住的地方",
      "对照资料修正",
      "自测题与复习日期",
    ],
  },
} satisfies Record<string, { label: string; headings: string[] }>;

export type LearningLogTemplateId = keyof typeof LEARNING_LOG_TEMPLATES;
export const LEARNING_LOG_TEMPLATE_IDS = Object.keys(
  LEARNING_LOG_TEMPLATES,
) as LearningLogTemplateId[];

export function learningLogBody(
  title: string,
  template: LearningLogTemplateId,
) {
  const sections = LEARNING_LOG_TEMPLATES[template].headings;
  return (
    [`# ${title}`, ...sections.map((heading) => `## ${heading}`)].join("\n\n") +
    "\n"
  );
}
