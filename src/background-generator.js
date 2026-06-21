import { splitKeywords, unique } from "./utils.js";

const domainRules = [
  {
    id: "ai",
    match: ["模型", "算法", "识别", "预测", "数据", "神经网络", "视觉", "大模型", "文本", "分类", "BERT"],
    label: "软件方法 / 算法数据处理",
    knownApproaches: [
      "基于规则、关键词或阈值的传统处理流程",
      "引入机器学习或深度学习模型进行特征提取、分类或预测",
      "通过置信度、人工复核或反馈更新机制提升复杂场景下的稳定性",
    ],
    painPoints: [
      "真实业务数据分布波动较大，模型泛化和稳定性不足",
      "识别精度、推理速度和可解释性难以同时兼顾",
      "复杂场景中容易出现误报、漏报或边界样本混淆",
    ],
    english: ["AI", "algorithm", "classification", "inference", "data processing"],
    ipcHints: ["G06N", "G06F", "G06V"],
  },
  {
    id: "hardware",
    match: ["装置", "传感器", "结构", "模块", "机构", "连接", "组件", "电路", "设备"],
    label: "装置结构 / 硬件系统",
    knownApproaches: [
      "采用固定结构件或标准模块组合实现目标功能",
      "通过部件连接关系、安装方式或驱动链路完成协同配合",
      "借助传感检测、控制单元和执行件联动提升系统稳定性",
    ],
    painPoints: [
      "结构件较多，装配维护成本偏高",
      "关键部件之间的协同关系不清，容易影响可靠性",
      "尺寸、功耗、强度和成本之间难以平衡",
    ],
    english: ["device", "assembly", "sensor", "module", "circuit"],
    ipcHints: ["H01", "H02", "G01", "F16"],
  },
  {
    id: "manufacturing",
    match: ["工艺", "制备", "制造", "加工", "流程", "产线", "焊接", "组装"],
    label: "制造工艺 / 生产流程",
    knownApproaches: [
      "按既定工序顺序完成原料、成型、处理和检测",
      "通过工艺参数控制良率、稳定性或加工效率",
      "借助自动化设备和在线监测提升产线一致性",
    ],
    painPoints: [
      "工艺窗口窄，对环境和参数波动敏感",
      "步骤多且人工依赖重，容易带来批次差异",
      "效率、良率和成本目标经常互相牵制",
    ],
    english: ["process", "manufacturing", "fabrication", "assembly line"],
    ipcHints: ["B23", "B29", "C23"],
  },
  {
    id: "material",
    match: ["材料", "涂层", "复合", "合金", "聚合物", "电解质", "纳米"],
    label: "材料配方 / 复合体系",
    knownApproaches: [
      "围绕成分比例、微观结构和制备条件展开优化",
      "通过复合填料、表面改性或掺杂策略提升性能",
      "在导电性、稳定性、强度或成本之间寻找平衡点",
    ],
    painPoints: [
      "性能提升可能伴随副作用，体系稳定性不足",
      "原料、配方和制备条件之间存在复杂耦合",
      "实验室效果难以稳定迁移到量产阶段",
    ],
    english: ["material", "coating", "composite", "electrolyte"],
    ipcHints: ["C08", "C09", "C22", "H01M"],
  },
];

function inferDomain(title, keywords) {
  const merged = [title, ...keywords].join(" ");
  return domainRules.find((rule) => rule.match.some((pattern) => merged.includes(pattern))) || domainRules[0];
}

function pickTerm(items = [], fallback = "") {
  return items.find((item) => String(item || "").trim()) || fallback;
}

function buildKeywordBreakdown(title, keywords, domain) {
  const coreObject = pickTerm(keywords, title || domain.label);
  const coreMethod = pickTerm(
    keywords.filter((item) => /识别|预测|检测|监测|控制|分类|制备|加工|连接|装配|预警/.test(item)),
    domain.knownApproaches[0],
  );
  const applicationScenario = title || coreObject || domain.label;
  const constraints = unique(
    keywords.filter((item) => /低|高|实时|在线|多模态|稳定|可靠|轻量|自动|精准|成本/.test(item)),
  );

  return {
    coreObject,
    coreMethod,
    applicationScenario,
    constraints,
    decompositionSummary: `研究对象偏向“${coreObject}”，核心动作偏向“${coreMethod}”，应用场景落在“${applicationScenario}”。`,
  };
}

function expandKeywords(title, keywords, domain, keywordBreakdown) {
  const zh = unique([
    title,
    ...keywords,
    keywordBreakdown.coreObject,
    keywordBreakdown.coreMethod,
    keywordBreakdown.applicationScenario,
    ...keywordBreakdown.constraints,
  ]).filter(Boolean);
  const en = unique([
    ...domain.english,
    ...(zh.some((item) => item.includes("方法")) ? ["method"] : []),
    ...(zh.some((item) => item.includes("系统")) ? ["system"] : []),
    ...(zh.some((item) => item.includes("装置")) ? ["device"] : []),
    ...(zh.some((item) => item.includes("检测") || item.includes("监测")) ? ["detection", "monitoring"] : []),
  ]);
  return { zh, en };
}

function buildSearchStrings(expandedKeywords, domain, keywordBreakdown) {
  const objectTerms = unique([keywordBreakdown.coreObject, keywordBreakdown.applicationScenario].filter(Boolean));
  const methodTerms = unique([keywordBreakdown.coreMethod, ...keywordBreakdown.constraints].filter(Boolean));
  const zhWide = expandedKeywords.zh.slice(0, 6).map((item) => `"${item}"`).join(" OR ");
  const enWide = expandedKeywords.en.slice(0, 8).map((item) => `"${item}"`).join(" OR ");
  const zhNarrow = [
    objectTerms.length ? `(${objectTerms.map((item) => `"${item}"`).join(" OR ")})` : "",
    methodTerms.length ? `(${methodTerms.map((item) => `"${item}"`).join(" OR ")})` : "",
  ]
    .filter(Boolean)
    .join(" AND ");
  const enNarrow = enWide;

  return {
    patentCn: `${zhNarrow || zhWide} AND (专利 OR 专利申请) AND (背景技术 OR 权利要求)`,
    patentGlobal: `${enNarrow || "patent"} AND patent AND claim`,
    paper: `${enNarrow || "review"} AND (paper OR article OR review)`,
    patentCnWide: zhWide,
    patentCnNarrow: zhNarrow || zhWide,
    paperWide: enWide,
    paperNarrow: enNarrow,
    ipcHints: domain.ipcHints,
  };
}

function buildCommonPracticeFlow(title, domain, keywordBreakdown) {
  const subject = keywordBreakdown.coreObject || title || domain.label;
  const steps = domain.knownApproaches.map((detail, index) => ({
    title: ["输入准备", "关键处理", "结果输出"][index] || `步骤${index + 1}`,
    detail,
  }));

  return {
    headline: `${subject}的常见技术路线`,
    summary: `通常先围绕${subject}完成输入或结构准备，再执行${keywordBreakdown.coreMethod}，最后输出可用于判断、控制或后续处理的结果。`,
    steps,
  };
}

function renderEntryList(entries = [], type = "paper") {
  if (!entries.length) {
    return type === "paper"
      ? ["当前没有解析到可展示论文条目；系统已尝试 Google Scholar，必要时会尝试熊猫学术镜像和 OpenAlex。"]
      : ["当前没有解析到可展示专利条目；请检查智慧芽 API 配置、响应结构，以及详情接口路径。"];
  }

  return entries.flatMap((entry, index) => {
    if (type === "paper") {
      return [
        `### 论文 ${index + 1}：${entry.title}`,
        `来源：${entry.source || "待核验"}；年份：${entry.year || "待核验"}；链接：${entry.sourceUrl || "待核验"}`,
        `相关性：${entry.relevance || "待人工复核"}`,
        `创新点：${(entry.innovationPoints || []).join("；") || "待补充"}`,
        `方法或流程：${(entry.methodSteps || []).join("；") || "待补充"}`,
        "",
      ];
    }

    return [
      `### 专利 ${index + 1}：${entry.title}`,
      `专利信息：${entry.publicationNumber || "待核验"}；${entry.applicant || "待核验"}；${entry.publicationDate || "待核验"}`,
      `相关性：${entry.relevance || "待人工复核"}`,
      `创新点：${(entry.innovationPoints || []).join("；") || "待补充"}`,
      `方法或流程：${(entry.methodSteps || []).join("；") || "待补充"}`,
      `对应权利焦点：${(entry.claimFocus || []).join("；") || "待补充"}`,
      "",
    ];
  });
}

export function buildBackgroundDossier({
  title = "",
  keywords = "",
  focus = "",
  customPainPoints = "",
  paperEntries: externalPaperEntries = [],
  patentEntries: externalPatentEntries = [],
  searchWarnings = [],
  searchDiagnostics = null,
  patentSearchUrl = "",
  patentSearchPortals = null,
}) {
  const parsedKeywords = splitKeywords(keywords);
  const domain = inferDomain(title, parsedKeywords);
  const keywordBreakdown = buildKeywordBreakdown(title, parsedKeywords, domain);
  const expandedKeywords = expandKeywords(title, parsedKeywords, domain, keywordBreakdown);
  const customPainPointList = splitKeywords(customPainPoints);
  const painPoints = unique([...customPainPointList, ...domain.painPoints]);
  const knownApproaches = domain.knownApproaches;
  const commonPracticeFlow = buildCommonPracticeFlow(title, domain, keywordBreakdown);
  const scenario = focus || `围绕“${title || parsedKeywords[0] || domain.label}”整理现有技术路线、论文方法、专利保护焦点和可写入背景技术的问题。`;
  const searchStrings = buildSearchStrings(expandedKeywords, domain, keywordBreakdown);
  const paperEntries = Array.isArray(externalPaperEntries) ? externalPaperEntries : [];
  const patentEntries = Array.isArray(externalPatentEntries) ? externalPatentEntries : [];

  const dossierMarkdown = [
    "# 背景技术资料包",
    "",
    `主题：${title || "待补充题目"}`,
    `技术方向：${domain.label}`,
    `应用焦点：${scenario}`,
    "",
    "## 拆题结果",
    `研究对象：${keywordBreakdown.coreObject}`,
    `核心方法：${keywordBreakdown.coreMethod}`,
    `应用场景：${keywordBreakdown.applicationScenario}`,
    `约束条件：${keywordBreakdown.constraints.join("、") || "当前未识别出明显约束词"}`,
    "",
    "## 检索关键词",
    `中文：${expandedKeywords.zh.join("、") || "待补充"}`,
    `英文：${expandedKeywords.en.join("、") || "待补充"}`,
    "",
    "## 常见现有技术路线",
    ...knownApproaches.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 相关论文路线",
    ...renderEntryList(paperEntries, "paper"),
    "## 相关专利路线",
    ...renderEntryList(patentEntries, "patent"),
    "## 可直接写进背景技术的痛点",
    ...painPoints.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 检索式",
    `- 中国专利：${searchStrings.patentCn}`,
    `- 国际专利：${searchStrings.patentGlobal}`,
    `- 论文：${searchStrings.paper}`,
    `- IPC/CPC：${searchStrings.ipcHints.join(" / ")}`,
    ...(searchWarnings.length ? ["", "## 检索提示", ...searchWarnings.map((item) => `- ${item}`)] : []),
  ].join("\n");

  return {
    title: title || "待补充题目",
    domain: domain.label,
    focus: scenario,
    keywordBreakdown,
    expandedKeywords,
    knownApproaches,
    commonPracticeFlow,
    paperEntries,
    patentEntries,
    painPoints,
    searchStrings,
    sourceChecklist: [
      "优先核对智慧芽原文、CNIPA 官方公开文本、独立权利要求和法律状态。",
      "论文条目需人工核验标题、来源、年份和链接后再写入正式交底材料。",
      "把论文方法步骤、专利权利焦点和待解决技术问题放在同一张表中对照。",
    ],
    searchWarnings,
    searchDiagnostics,
    patentSearchUrl,
    patentSearchPortals,
    dossierMarkdown,
  };
}
