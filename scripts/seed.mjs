import fs from "node:fs";
import path from "node:path";
export function seed(vault) {
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const note = path.join(vault, "从一个问题开始.md");
  if (!fs.existsSync(note))
    fs.writeFileSync(
      note,
      "---\ntitle: 从一个问题开始\nnote_type: concept\ndomain: analog-ic\nstatus: working\ntags: [练习, MOS]\ncustom_property: 保留这个自定义字段\n---\n\n# 从一个问题开始\n\n这是**隔离测试库**中的编辑示例，不代表已经验证的工程结论。\n\n## 留下最初的想法\n\n先写一个问题，再记录推导过程。用 [[今天的学习记录]] 连接观察和想法。\n\n## 公式与适用条件\n\n例如，在理想长沟道模型及其适用条件下：\n\n$$\ng_m = \\frac{2 I_D}{V_{ov}}\n$$\n\n继续追问：实际器件的条件变化，会怎样影响这个近似？\n\n## 对照与核对\n\n| 记录 | 下一步 |\n| --- | --- |\n| 近似模型 | 核对条件 |\n| 仿真观察 | 留下来源 |\n\n## 尚未解决\n\n- [ ] 记录一张值得回看的截图\n- [ ] 为新结论补充适用条件\n",
    );
  const journal = path.join(vault, "今天的学习记录.md");
  if (!fs.existsSync(journal))
    fs.writeFileSync(
      journal,
      "---\nnote_type: learning-log\nstatus: working\n---\n\n# 今天的学习记录\n\n## 这次的问题\n\n记录来自 [[从一个问题开始]] 的疑问。\n\n## 下一步\n\n给下一次学习留下线索。\n",
    );
}
