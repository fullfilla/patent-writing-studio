import { createChatCompletion, createJsonCompletion, hasConfiguredLlm } from "./llm-client.js";

function uniq(items = [], limit = 6) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function withFallbackMeta(payload, warning = "") {
  return {
    ...payload,
    generationMode: "rule-based",
    generationModeLabel: warning ? `本地规则（LLM 调用失败：${warning}）` : "本地规则",
  };
}

export async function enhanceStyleProfile({
  profile,
  agentName,
  masterName,
  rawText,
  notes,
  settings,
}) {
  if (!hasConfiguredLlm(settings)) {
    return withFallbackMeta(profile);
  }

  try {
    const { data, model } = await createJsonCompletion({
      settings,
      temperature: 0.2,
      systemPrompt:
        "你是资深中文专利代理写作分析师。请根据给定样本总结写作风格，输出严格 JSON，不要输出解释。",
      userPrompt: [
        "请分析下面的专利写作样本，输出 JSON：",
        "{",
        '  "archetype": "一句中文风格名称",',
        '  "toneSummary": "一句中文总结",',
        '  "signaturePhrases": ["高频表达1", "高频表达2"],',
        '  "writingHabits": ["习惯1", "习惯2", "习惯3"],',
        '  "templateMoves": ["迁移动作1", "迁移动作2", "迁移动作3"],',
        '  "sampleCountHint": "一句样本数量建议"',
        "}",
        "",
        `候选代理师：${agentName || "未提供"}`,
        `样本名称：${masterName || "未提供"}`,
        `补充备注：${notes || "无"}`,
        "样本文本：",
        rawText || profile.rawExcerptPreview,
      ].join("\n"),
    });

    return {
      ...profile,
      archetype: data.archetype || profile.archetype,
      toneSummary: data.toneSummary || profile.toneSummary,
      signaturePhrases: uniq([...(data.signaturePhrases || []), ...(profile.signaturePhrases || [])], 8),
      writingHabits: uniq(data.writingHabits || profile.writingHabits, 6),
      templateMoves: uniq(data.templateMoves || profile.templateMoves, 6),
      sampleCountHint: data.sampleCountHint || profile.sampleCountHint,
      generationMode: "llm",
      generationModeLabel: `LLM：${model}`,
    };
  } catch (error) {
    return withFallbackMeta(profile, error.message);
  }
}

export async function enhanceBackgroundDossier({
  background,
  title,
  keywords,
  focus,
  painPoints,
  settings,
}) {
  if (!hasConfiguredLlm(settings)) {
    return withFallbackMeta(background);
  }

  try {
    const { data, model } = await createJsonCompletion({
      settings,
      temperature: 0.3,
      systemPrompt:
        "你是中文专利代理写作助手，擅长把技术主题整理成可写入说明书的背景技术资料包。输出严格 JSON。",
      userPrompt: [
        "请根据主题整理背景技术资料包，并输出 JSON：",
        "{",
        '  "domain": "技术方向",',
        '  "focus": "一句应用焦点",',
        '  "knownApproaches": ["常见路线1", "常见路线2", "常见路线3"],',
        '  "painPoints": ["痛点1", "痛点2", "痛点3"],',
        '  "sourceChecklist": ["后续检索建议1", "后续检索建议2", "后续检索建议3"],',
        '  "dossierMarkdown": "完整 markdown 文本"',
        "}",
        "",
        `题目：${title || "未提供"}`,
        `关键词：${keywords || "未提供"}`,
        `应用焦点：${focus || "未提供"}`,
        `已知痛点：${painPoints || "未提供"}`,
        "",
        "已有草稿：",
        background.dossierMarkdown,
      ].join("\n"),
    });

    return {
      ...background,
      domain: data.domain || background.domain,
      focus: data.focus || background.focus,
      knownApproaches: uniq(data.knownApproaches || background.knownApproaches, 6),
      painPoints: uniq(data.painPoints || background.painPoints, 6),
      sourceChecklist: uniq(data.sourceChecklist || background.sourceChecklist, 6),
      dossierMarkdown: data.dossierMarkdown || background.dossierMarkdown,
      generationMode: "llm",
      generationModeLabel: `LLM：${model}`,
    };
  } catch (error) {
    return withFallbackMeta(background, error.message);
  }
}

export async function enhancePatentTemplate({
  template,
  styleProfile,
  background,
  title,
  keywords,
  patentType,
  settings,
}) {
  if (!hasConfiguredLlm(settings)) {
    return withFallbackMeta(template);
  }

  try {
    const { text, model } = await createChatCompletion({
      settings,
      temperature: 0.35,
      systemPrompt:
        "你是资深中文专利代理写作助手。请把题目、技术领域、背景、发明目的、摘要和通用说明尽量写成可直接使用的专利底稿；只在真正需要用户补充创新细节、具体步骤、参数、模型结构或权利要求限定的位置保留占位。只输出 markdown 正文，不要解释。",
      userPrompt: [
        `题目：${title || "未提供"}`,
        `关键词：${keywords || "未提供"}`,
        `专利类型：${patentType || "发明专利"}`,
        `风格画像：${styleProfile.displayName} / ${styleProfile.archetype}`,
        `风格总结：${styleProfile.toneSummary}`,
        `风格习惯：${(styleProfile.writingHabits || []).join("；")}`,
        `背景方向：${background.domain}`,
        `背景焦点：${background.focus}`,
        "",
        "请在下面模板基础上优化措辞和结构。可根据题目与背景直接写好的内容必须写出来，不要把摘要、技术领域、背景技术写成空模板；只保留核心创新细节位置的占位符：",
        template.markdown,
      ].join("\n"),
    });

    return {
      ...template,
      markdown: text.trim(),
      generationMode: "llm",
      generationModeLabel: `LLM：${model}`,
    };
  } catch (error) {
    return withFallbackMeta(template, error.message);
  }
}
