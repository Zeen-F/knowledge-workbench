import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  GENERAL_PROFILE,
  RESEARCH_CORE,
  RESEARCH_REFERENCES,
  portableResearchSkill,
  researchSnapshotSchema,
  snapshotResearchProfile,
} from "../shared/research-profiles.ts";
import { researchChecks } from "../shared/research-checks.ts";

test("research profile is optional and uses only its selected progressive reference", () => {
  assert.equal(snapshotResearchProfile(), undefined);
  assert.equal(snapshotResearchProfile(GENERAL_PROFILE), undefined);
  const notes = snapshotResearchProfile({
    id: "analog-ic-research",
    focus: "notes",
  })!;
  assert.equal(notes.instructions, RESEARCH_CORE);
  for (const focus of ["paper", "experiment"] as const) {
    const profile = snapshotResearchProfile({
      id: "analog-ic-research",
      focus,
    })!;
    assert.equal(
      profile.instructions,
      RESEARCH_CORE + "\n\n" + RESEARCH_REFERENCES[focus],
    );
    assert.equal(
      profile.instructions.includes(
        RESEARCH_REFERENCES[focus === "paper" ? "experiment" : "paper"],
      ),
      false,
    );
  }
  assert.throws(() =>
    snapshotResearchProfile({ id: "outside-profile", focus: "notes" }),
  );
  assert.throws(() =>
    researchSnapshotSchema.parse({
      ...notes,
      instructions: "Read the whole vault",
    }),
  );
  assert.throws(() =>
    researchSnapshotSchema.parse({ ...notes, version: "0.0.0" }),
  );
});

test("portable Codex skill package is identical to versioned API instructions", () => {
  const root = new URL(
    "../plugins/knowledge-workbench/skills/analog-ic-research/",
    import.meta.url,
  );
  assert.equal(
    fs.readFileSync(new URL("SKILL.md", root), "utf8"),
    portableResearchSkill(),
  );
  for (const [name, contents] of Object.entries(RESEARCH_REFERENCES))
    assert.equal(
      fs.readFileSync(new URL(`references/${name}.md`, root), "utf8"),
      contents + "\n",
    );
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../plugins/knowledge-workbench/.codex-plugin/plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(manifest.skills, "./skills/");
});

test("deterministic flags preserve raw synthetic LDO/RC data and do not claim validation", () => {
  const profile = snapshotResearchProfile({
    id: "analog-ic-research",
    focus: "experiment",
  })!;
  const raw =
    "Synthetic fixture only. LDO 仿真稳定。PM=60\nPSRR=45\nR=10\nC=2\n用户假设：所有负载都稳定？";
  const checks = researchChecks(profile, raw);
  assert.equal(checks.filter((c) => c.code === "MISSING_UNIT").length, 4);
  assert.ok(checks.some((c) => c.code === "CHECK_PVT"));
  assert.ok(checks.some((c) => c.code === "CHECK_FREQUENCY"));
  assert.equal(
    raw,
    "Synthetic fixture only. LDO 仿真稳定。PM=60\nPSRR=45\nR=10\nC=2\n用户假设：所有负载都稳定？",
  );
  assert.deepEqual(researchChecks(undefined, raw), []);
  const withConditions =
    "LDO 仿真 PM=60°; PSRR=45 dB at 1 kHz; R=10 kΩ; C=2 nF; PVT=TT; 供电 1.8 V; 温度25℃; 负载1mA";
  assert.deepEqual(researchChecks(profile, withConditions), []);
  // Dimensionless numeric data is not flagged merely because it has a number.
  assert.deepEqual(researchChecks(profile, "样本数量=60\n编号=10"), []);
});
