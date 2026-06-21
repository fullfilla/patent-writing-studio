import test from "node:test";
import assert from "node:assert/strict";
import { buildBackgroundDossier } from "../src/background-generator.js";

test("buildBackgroundDossier expands hardware-oriented topics", () => {
  const dossier = buildBackgroundDossier({
    title: "一种用于电池热失控预警的多模态监测装置",
    keywords: "电池，热失控，监测，传感器，多模态",
  });

  assert.equal(dossier.domain, "装置结构 / 硬件系统");
  assert.ok(dossier.searchStrings.patentCn.includes("背景技术"));
  assert.ok(dossier.dossierMarkdown.includes("背景技术资料包"));
});
