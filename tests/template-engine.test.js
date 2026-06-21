import test from "node:test";
import assert from "node:assert/strict";
import { buildPatentTemplate } from "../src/template-engine.js";

test("buildPatentTemplate leaves editable placeholders", () => {
  const template = buildPatentTemplate({
    title: "一种智能监测系统",
    keywords: "智能监测，传感器，预警",
    patentType: "发明专利",
    leaveBlankMode: true,
    styleProfile: {
      displayName: "测试风格",
      templateMoves: ["先写背景，再写方案。"],
    },
    background: {
      domain: "装置结构 / 硬件系统",
      knownApproaches: ["采用固定结构件组合实现功能。", "通过检测单元与控制单元联动。"],
      painPoints: ["误报率高。", "布线复杂。"],
    },
  });

  assert.ok(template.markdown.includes("[请在此填写"));
  assert.ok(template.markdown.includes("权利要求骨架"));
});
