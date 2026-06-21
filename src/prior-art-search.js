import { createJsonCompletion, hasConfiguredLlm } from "./llm-client.js";
import { splitKeywords, unique } from "./utils.js";

const DEFAULT_TIMEOUT_MS = 12000;
const INTERACTIVE_PAPER_TIMEOUT_MS = 20000;
const INTERACTIVE_PATENT_TIMEOUT_MS = 60000;
const INTERACTIVE_KEYWORD_TIMEOUT_MS = 5000;
const GENERIC_SEARCH_TERMS = new Set([
  "method",
  "system",
  "device",
  "model",
  "data",
  "based",
  "using",
  "with",
  "and",
  "for",
  "一种",
  "方法",
  "系统",
  "装置",
  "设备",
  "模型",
  "基于",
]);

const PAPER_CONCEPTS = [
  {
    id: "bert",
    match: [/bert/i, /预训练语言模型/, /中文预训练/],
    terms: ["BERT", "bert-base-chinese", "pre-trained language model"],
    requiredAny: ["bert"],
  },
  {
    id: "sentiment",
    match: [/情感分析/, /情绪分析/, /观点挖掘/, /sentiment/i, /opinion mining/i],
    terms: ["sentiment analysis", "sentiment classification", "opinion mining", "情感分析"],
    requiredAny: ["sentiment", "opinion", "情感", "情绪", "观点"],
  },
  {
    id: "text-classification",
    match: [/文本分类/, /多分类/, /分类识别/, /text classification/i],
    terms: ["text classification", "document classification", "文本分类"],
    requiredAny: ["classification", "classify", "分类"],
  },
  {
    id: "work-order",
    match: [/工单/, /热线/, /派单/, /service request/i, /work order/i, /ticket/i],
    terms: ["work order classification", "service request classification", "ticket routing", "public service hotline"],
    requiredAny: ["work order", "service request", "ticket", "hotline", "工单", "热线", "派单"],
  },
];

function compactText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isCleanSearchFragment(value = "") {
  const text = compactText(value);
  if (!text) return false;
  if (/[�锟绋鐨勫伐鍗曡瘑鍒炴柟娉曠郴粺]/.test(text)) return false;
  if (/\?{2,}|\\uFFFD/i.test(text)) return false;
  if (/基于规则、关键词或阈值|传统处理流程|待补充|未生成|重新点击/.test(text)) return false;
  return true;
}

function cleanSearchFragments(values = []) {
  return values.map((item) => compactText(item)).filter(isCleanSearchFragment);
}

function hasTopicText(pattern, values = []) {
  return pattern.test(cleanSearchFragments(values).join(" "));
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message || `请求超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function buildQuery({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  return unique([
    title,
    ...splitKeywords(keywords),
    keywordBreakdown.coreObject,
    keywordBreakdown.coreMethod,
    keywordBreakdown.applicationScenario,
  ])
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
}

function splitSearchTerms(value = "") {
  if (!isCleanSearchFragment(value)) return [];
  return unique(
    String(value || "")
      .split(/[\s,，、;；|/()（）[\]{}"'“”‘’]+/g)
      .map((item) => compactText(item))
      .filter((item) => item.length >= 2)
      .filter((item) => !GENERIC_SEARCH_TERMS.has(item.toLowerCase())),
  );
}

function buildPaperQuery({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  const concepts = detectPaperConcepts({ title, keywords, keywordBreakdown });
  const conceptTerms = concepts.flatMap((concept) => concept.terms).slice(0, 6);
  return unique([
    ...conceptTerms,
    ...cleanSearchFragments([keywordBreakdown.coreObject, keywordBreakdown.coreMethod]),
    ...splitSearchTerms(title),
    ...splitSearchTerms(keywords),
  ])
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
}

function buildBroadPaperQueries({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  const concepts = detectPaperConcepts({ title, keywords, keywordBreakdown });
  const cleanInputs = [title, keywords, keywordBreakdown.coreObject, keywordBreakdown.coreMethod, ...(keywordBreakdown.constraints || [])];
  const hasBert = concepts.some((concept) => concept.id === "bert") || hasTopicText(/bert/i, cleanInputs);
  const hasWorkOrder = concepts.some((concept) => concept.id === "work-order") || hasTopicText(/工单|热线|ticket|work order|service request/i, cleanInputs);
  const hasClassification =
    concepts.some((concept) => concept.id === "text-classification") || hasTopicText(/识别|分类|classification|classify/i, cleanInputs);
  const cleanTitleQuery = splitSearchTerms(title).slice(0, 8).join(" ");

  return unique([
    hasBert && hasWorkOrder ? "BERT work order classification" : "",
    hasBert && hasWorkOrder ? "BERT ticket classification" : "",
    hasBert && hasWorkOrder ? "BERT service request classification" : "",
    hasBert && hasWorkOrder ? "public service request text classification BERT" : "",
    hasBert && hasWorkOrder ? "public service hotline work order classification" : "",
    hasBert && hasClassification ? "bert-base-chinese text classification" : "",
    hasBert && hasClassification ? "Chinese BERT text classification" : "",
    hasBert && hasWorkOrder ? '"BERT" "work order classification"' : "",
    hasBert && hasWorkOrder ? '"BERT" "ticket classification"' : "",
    hasBert && hasWorkOrder ? '"BERT" "service request classification"' : "",
    hasBert && hasClassification ? '"bert-base-chinese" "text classification"' : "",
    hasBert && hasClassification ? '"Chinese BERT" "text classification"' : "",
    hasWorkOrder ? '"work order classification"' : "",
    hasWorkOrder ? '"ticket routing" "classification"' : "",
    hasWorkOrder ? '"service request" "text classification"' : "",
    hasBert ? '"BERT" "text classification"' : "",
    hasBert ? '"bert-base-chinese"' : "",
    buildPaperQuery({ title, keywords, keywordBreakdown }),
    cleanSearchFragments([keywordBreakdown.coreObject, keywordBreakdown.coreMethod]).join(" "),
    cleanTitleQuery,
  ]).filter(Boolean);
}

function detectPaperConcepts({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  const text = cleanSearchFragments([title, keywords, keywordBreakdown.coreObject, keywordBreakdown.coreMethod, keywordBreakdown.applicationScenario]).join(" ");
  return PAPER_CONCEPTS.filter((concept) => concept.match.some((pattern) => pattern.test(text)));
}

function buildPaperRequiredGroups({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  const concepts = detectPaperConcepts({ title, keywords, keywordBreakdown });
  return concepts.map((concept) => concept.requiredAny).filter((group) => group.length);
}

function buildRelevanceTerms({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  return unique([
    ...splitSearchTerms(title),
    ...splitSearchTerms(keywords),
    ...splitSearchTerms(keywordBreakdown.coreObject),
    ...splitSearchTerms(keywordBreakdown.coreMethod),
    ...splitSearchTerms(keywordBreakdown.applicationScenario),
  ]).slice(0, 18);
}

function hasRequiredPaperConcepts(entry = {}, requiredGroups = []) {
  if (!requiredGroups.length) return true;
  const haystack = [entry.title, entry.source, entry.year, entry.doi, ...(entry.innovationPoints || []), ...(entry.methodSteps || [])]
    .join(" ")
    .toLowerCase();
  return requiredGroups.every((group) => group.some((term) => haystack.includes(String(term).toLowerCase())));
}

function scorePaperEntry(entry = {}, requiredGroups = [], relevanceTerms = []) {
  const haystack = [entry.title, entry.source, entry.year, entry.doi, ...(entry.innovationPoints || []), ...(entry.methodSteps || [])]
    .join(" ")
    .toLowerCase();
  const requiredHits = requiredGroups.reduce(
    (sum, group) => sum + (group.some((term) => haystack.includes(String(term).toLowerCase())) ? 1 : 0),
    0,
  );
  const relevanceHits = relevanceTerms.filter((term) => haystack.includes(String(term).toLowerCase())).length;
  return requiredHits * 10 + relevanceHits;
}

function hasRelevantTerm(entry = {}, relevanceTerms = [], requiredGroups = []) {
  if (!hasRequiredPaperConcepts(entry, requiredGroups)) return false;
  if (!relevanceTerms.length) return true;
  const haystack = [entry.title, entry.source, entry.year, entry.doi, ...(entry.innovationPoints || []), ...(entry.methodSteps || [])]
    .join(" ")
    .toLowerCase();
  const hitCount = relevanceTerms.filter((term) => haystack.includes(String(term).toLowerCase())).length;
  return hitCount >= Math.min(2, relevanceTerms.length);
}

function hasLooseRelevantTerm(entry = {}, relevanceTerms = [], requiredGroups = []) {
  const haystack = [entry.title, entry.source, entry.year, entry.doi, ...(entry.innovationPoints || []), ...(entry.methodSteps || [])]
    .join(" ")
    .toLowerCase();
  if (/\blottery\b.*\btickets?\b|\btickets?\b.*\blottery\b/.test(haystack)) return false;
  const requiredHitCount = requiredGroups.filter((group) => group.some((term) => haystack.includes(String(term).toLowerCase()))).length;
  const requiredHit = !requiredGroups.length || requiredHitCount >= Math.min(2, requiredGroups.length);
  const relevanceHit = !relevanceTerms.length || relevanceTerms.some((term) => haystack.includes(String(term).toLowerCase()));
  return requiredHit && (relevanceHit || requiredHitCount >= 2);
}

function uniqueEntries(entries = [], limit = 5) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = compactText(entry.doi || entry.sourceUrl || entry.title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

function buildChinesePaperTitle(title = "") {
  const text = compactText(title);
  const known = [
    {
      match: /Public Service Request Text Classification Based on BERT-BiLSTM-CNN Feature Fusion/i,
      title: "基于 BERT-BiLSTM-CNN 特征融合的公共服务请求文本分类研究",
    },
    {
      match: /Classification of Work Orders based on BERT and Feature Fusion/i,
      title: "基于 BERT 与特征融合的工单分类研究",
    },
    {
      match: /Text Classification of Power Work Orders Based on RoBERTa-RCNN and Channel Attention/i,
      title: "基于 RoBERTa-RCNN 与通道注意力机制的电力工单文本分类研究",
    },
  ];
  return known.find((item) => item.match.test(text))?.title || text;
}

function summarizePaperInChinese(entry = {}) {
  const title = compactText(entry.title);
  const titleZh = buildChinesePaperTitle(title);
  const haystack = [title, ...(entry.innovationPoints || [])].join(" ");
  const isPublicService = /public service request|公共服务|热线/i.test(haystack);
  const isWorkOrder = /work orders?|工单/i.test(haystack);
  const isPower = /power work orders?|电力/i.test(haystack);
  const model =
    /RoBERTa/i.test(haystack)
      ? "RoBERTa-RCNN 与通道注意力机制"
      : /BiLSTM/i.test(haystack) || /CNN/i.test(haystack)
        ? "BERT-BiLSTM-CNN 特征融合模型"
        : /BERT/i.test(haystack)
          ? "BERT 语义表示与特征融合模型"
          : "文本分类模型";
  const scene = isPublicService ? "公共服务请求文本分类" : isPower ? "电力工单文本分类" : isWorkOrder ? "工单分类" : "中文文本分类";
  return {
    ...entry,
    titleZh,
    displayTitle: titleZh,
    innovationPoints: [
      `将${model}用于${scene}，提升短文本、口语化或多类别工单场景下的语义表征能力。`,
      "通过融合上下文语义、局部关键词特征和序列依赖信息，缓解单一模型对复杂工单类别边界识别不足的问题。",
    ],
    methodSteps: [
      "收集并标注业务请求或工单文本，完成清洗、分词/字粒度编码、长度截断和标签规范化。",
      `将处理后的文本输入${model}，提取上下文语义特征、局部短语特征和类别判别特征。`,
      "将融合后的特征输入分类层输出工单类别，并通过准确率、召回率、F1 值等指标评估分类效果。",
    ],
    relevance: entry.relevance || `待人工复核：该论文围绕${scene}和预训练语言模型分类方法，与本主题的工单识别路线相关。`,
  };
}

async function refinePaperEntryWithLlm(entry = {}, settings = {}) {
  const normalized = summarizePaperInChinese(entry);
  if (!hasConfiguredLlm(settings)) return normalized;
  try {
    const { data } = await createJsonCompletion({
      settings,
      temperature: 0.15,
      systemPrompt: "你是中文专利检索分析助手。只基于给定论文题名、来源和摘要线索，输出严格 JSON，不编造实验数据。",
      userPrompt: [
        "请把论文信息整理成中文 JSON：",
        "{",
        '  "titleZh": "中文题名",',
        '  "innovationPoints": ["中文创新点1", "中文创新点2"],',
        '  "methodSteps": ["中文方法步骤1", "中文方法步骤2", "中文方法步骤3"]',
        "}",
        "",
        `英文题名：${entry.title || ""}`,
        `来源：${entry.source || ""} ${entry.year || ""}`,
        `摘要线索：${clipForPrompt((entry.innovationPoints || []).join("；"), 1200) || "无"}`,
      ].join("\n"),
    });
    return {
      ...normalized,
      titleZh: compactText(data.titleZh) || normalized.titleZh,
      displayTitle: compactText(data.titleZh) || normalized.displayTitle,
      innovationPoints: Array.isArray(data.innovationPoints) && data.innovationPoints.length ? data.innovationPoints : normalized.innovationPoints,
      methodSteps: Array.isArray(data.methodSteps) && data.methodSteps.length ? data.methodSteps : normalized.methodSteps,
    };
  } catch {
    return normalized;
  }
}

async function refinePaperEntries(entries = [], settings = {}) {
  const refined = [];
  for (const entry of entries.slice(0, 3)) {
    refined.push(await refinePaperEntryWithLlm(entry, settings));
  }
  return refined;
}

function buildPatentTerms({ title = "", keywords = "", keywordBreakdown = {}, suggestedKeywords = [] } = {}) {
  return unique([
    ...splitSearchTerms(title),
    ...splitSearchTerms(keywords),
    ...splitSearchTerms(keywordBreakdown.coreObject),
    ...splitSearchTerms(keywordBreakdown.coreMethod),
    ...splitSearchTerms(keywordBreakdown.applicationScenario),
    ...suggestedKeywords.flatMap((item) => splitSearchTerms(item)),
  ]).slice(0, 18);
}

function buildPatentRequestBody({
  provider = "",
  query = "",
  title = "",
  keywords = "",
  keywordBreakdown = {},
  suggestedKeywords = [],
  limit = 8,
} = {}) {
  if (provider === "patsnap") {
    const semanticText = buildSemanticPatentText({ title, keywords, keywordBreakdown, suggestedKeywords });
    return {
      text: semanticText || query,
      field: "RELEVANCY",
      order: "desc",
      limit,
      offset: 0,
    };
  }
  return {
    query,
    keywords: splitKeywords(keywords),
    title,
    limit,
    page: 1,
    pageSize: limit,
  };
}

function buildSemanticPatentText({ title = "", keywords = "", keywordBreakdown = {}, suggestedKeywords = [] } = {}) {
  const parts = unique(cleanSearchFragments([
    title,
    keywords,
    keywordBreakdown.coreObject,
    keywordBreakdown.coreMethod,
    keywordBreakdown.applicationScenario,
    ...(keywordBreakdown.constraints || []),
    ...suggestedKeywords.slice(0, 12),
  ]));
  return parts.join("。");
}

function buildPatentSemanticQueries({ title = "", keywords = "", keywordBreakdown = {}, suggestedKeywords = [] } = {}) {
  const titleTerms = splitSearchTerms(title);
  const keywordTerms = splitSearchTerms(keywords);
  const cleanInputs = [title, keywords, ...cleanSearchFragments(suggestedKeywords)];
  const hasBert = hasTopicText(/bert/i, cleanInputs);
  const hasWorkOrder = hasTopicText(/工单|热线|ticket|work order|service request/i, cleanInputs);
  return unique([
    title,
    hasBert && hasWorkOrder ? "bert-base-chinese 公共服务热线 工单识别" : "",
    hasBert && hasWorkOrder ? "BERT 公共服务热线 工单 分类" : "",
    hasBert && hasWorkOrder ? "BERT 工单 识别 分类" : "",
    hasBert && hasWorkOrder ? "bert-base-chinese 工单 分类" : "",
    hasWorkOrder ? "公共服务热线 工单识别 方法 系统" : "",
    hasWorkOrder ? "公共服务热线 工单 识别" : "",
    hasWorkOrder ? "工单识别 方法 系统" : "",
    hasWorkOrder ? "文本分类 工单 识别" : "",
    hasWorkOrder ? "工单 分类 派单 识别" : "",
    hasBert ? "BERT 文本分类 识别 方法" : "",
    buildSemanticPatentText({ title, keywords, keywordBreakdown, suggestedKeywords }),
    cleanSearchFragments([keywordBreakdown.coreObject, keywordBreakdown.coreMethod]).join("。"),
    titleTerms.slice(0, 6).join(" "),
    keywordTerms.slice(0, 6).join(" "),
    ...cleanSearchFragments(suggestedKeywords).slice(0, 6),
  ]).filter(Boolean);
}

function summarizePayloadShape(value, depth = 0) {
  if (depth > 3) return "...";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length ? summarizePayloadShape(value[0], depth + 1) : null,
    };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 12)
        .map(([key, item]) => [key, summarizePayloadShape(item, depth + 1)]),
    );
  }
  return typeof value;
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "patent-writing-studio/1.0",
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `请求失败（${response.status}）`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPatentJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startedAt = Date.now();
    const requestId = `pws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    console.log(`[patent-api] GET ${url} requestId=${requestId} auth=${headers.Authorization ? "bearer" : headers["x-api-key"] ? "x-api-key" : "none"}`);
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "patent-writing-studio/1.0",
        "X-Request-ID": requestId,
        ...headers,
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (payload && typeof payload === "object") {
      payload.__requestMeta = {
        requestId,
        responseStatus: response.status,
        correlationId:
          response.headers?.get?.("x-correlation-id") ||
          response.headers?.get?.("x-request-id") ||
          response.headers?.get?.("x-trace-id") ||
          "",
        openapiAmount: response.headers?.get?.("x-openapi-amount") || "",
      };
    }
    console.log(
      `[patent-api] response ${response.status ?? "mock"} elapsedMs=${Date.now() - startedAt} shape=${JSON.stringify(summarizePayloadShape(payload)).slice(0, 500)}`,
    );
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || payload?.msg || `请求失败（${response.status}）`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    const payload = await response.text();
    if (!response.ok) {
      throw new Error(`请求失败（${response.status}）`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(url, body, { headers = {}, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startedAt = Date.now();
    const isPatentApi = String(url).includes("connect.zhihuiya.com");
    const requestId =
      isPatentApi && !headers["X-Request-ID"]
        ? `pws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        : headers["X-Request-ID"];
    if (String(url).includes("connect.zhihuiya.com")) {
      console.log(
        `[patent-api] POST ${url} requestId=${requestId || ""} body=${JSON.stringify(body).slice(0, 500)} auth=${headers.Authorization ? "bearer" : headers["x-api-key"] ? "x-api-key" : "none"}`,
      );
    }
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "patent-writing-studio/1.0",
        ...(requestId ? { "X-Request-ID": requestId } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (payload && typeof payload === "object") {
      payload.__requestMeta = {
        requestId,
        responseStatus: response.status,
        correlationId:
          response.headers?.get?.("x-correlation-id") ||
          response.headers?.get?.("x-request-id") ||
          response.headers?.get?.("x-trace-id") ||
          "",
        openapiAmount: response.headers?.get?.("x-openapi-amount") || "",
      };
    }
    if (String(url).includes("connect.zhihuiya.com")) {
      console.log(
        `[patent-api] response ${response.status ?? "mock"} elapsedMs=${Date.now() - startedAt} shape=${JSON.stringify(summarizePayloadShape(payload)).slice(0, 500)}`,
      );
    }
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || payload?.msg || `请求失败（${response.status}）`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function invertAbstract(index = {}) {
  const positions = [];
  for (const [word, wordPositions] of Object.entries(index || {})) {
    for (const position of wordPositions || []) {
      positions[position] = word;
    }
  }
  return compactText(positions.filter(Boolean).join(" "));
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(value = "") {
  return compactText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " ")));
}

function buildScholarUrl(baseUrl, query) {
  const url = new URL(baseUrl);
  url.searchParams.set("hl", "zh-CN");
  url.searchParams.set("q", query);
  return url.toString();
}

function buildScholarQueries({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  const concepts = detectPaperConcepts({ title, keywords, keywordBreakdown });
  const conceptQuery = concepts.map((concept) => concept.terms[0]).filter(Boolean).join(" ");
  return unique([
    concepts.some((concept) => concept.id === "bert") && concepts.some((concept) => concept.id === "sentiment")
      ? '"BERT" "sentiment analysis"'
      : "",
    conceptQuery,
    buildPaperQuery({ title, keywords, keywordBreakdown }),
    [keywordBreakdown.coreObject, keywordBreakdown.coreMethod].filter(Boolean).join(" "),
    splitSearchTerms(title).slice(0, 6).join(" "),
    splitSearchTerms(keywords).slice(0, 6).join(" "),
  ]).filter(Boolean);
}

function parseGoogleScholarHtml(html = "", sourceName = "Google Scholar") {
  const blocks = String(html || "").match(/<div[^>]+class="[^"]*\bgs_r\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bgs_r\b|<div id="gs_res_ccl_bot|<\/body>)/g) || [];
  return blocks
    .map((block) => {
      const titleMatch = block.match(/<h3[^>]*class="[^"]*\bgs_rt\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
      const linkMatch = titleMatch?.[1]?.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const metaMatch = block.match(/<div[^>]*class="[^"]*\bgs_a\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const snippetMatch = block.match(/<div[^>]*class="[^"]*\bgs_rs\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const title = stripHtml(linkMatch?.[2] || titleMatch?.[1] || "");
      const sourceUrl = decodeHtmlEntities(linkMatch?.[1] || "");
      const meta = stripHtml(metaMatch?.[1] || "");
      const snippet = stripHtml(snippetMatch?.[1] || "");
      const year = meta.match(/\b(19|20)\d{2}\b/)?.[0] || "";
      return {
        title,
        source: meta || sourceName,
        year,
        doi: "",
        sourceUrl,
        relevance: `待人工复核：由 ${sourceName} 页面检索返回，已按题目概念做相关性过滤。`,
        innovationPoints: snippet ? [snippet.slice(0, 220)] : [],
        methodSteps: [],
      };
    })
    .filter((entry) => entry.title && entry.sourceUrl && !entry.sourceUrl.startsWith("/"));
}

export async function searchGoogleScholarWorks({ title = "", keywords = "", keywordBreakdown = {}, limit = 5, fetchImpl } = {}) {
  const relevanceTerms = buildRelevanceTerms({ title, keywords, keywordBreakdown });
  const requiredGroups = buildPaperRequiredGroups({ title, keywords, keywordBreakdown });
  const queries = buildScholarQueries({ title, keywords, keywordBreakdown });
  const attempts = [];
  if (!queries.length) {
    return { entries: [], diagnostics: { attempts, query: "" } };
  }

  const bases = [
    { name: "Google Scholar", url: "https://scholar.google.com/scholar" },
    { name: "熊猫学术", url: "https://sc.panda985.com/scholar" },
    { name: "熊猫学术", url: "https://sc.panda985.com/" },
  ];

  for (const query of queries.slice(0, 3)) {
    for (const base of bases) {
      const url = buildScholarUrl(base.url, query);
      try {
        const html = await fetchText(url, { fetchImpl, timeoutMs: 15000 });
        const blocked = /unusual traffic|captcha|sorry\/index|请进行人机身份验证|验证您不是机器人/i.test(html);
        const parsedEntries = blocked ? [] : parseGoogleScholarHtml(html, base.name);
        attempts.push({
          source: base.name,
          url,
          query,
          blocked,
          parsed: parsedEntries.length,
          ok: parsedEntries.length > 0,
        });
        const entries = uniqueEntries(
          parsedEntries
            .filter((entry) => hasRequiredPaperConcepts(entry, requiredGroups))
            .sort((left, right) => scorePaperEntry(right, requiredGroups, relevanceTerms) - scorePaperEntry(left, requiredGroups, relevanceTerms)),
          limit,
        );
        if (entries.length) {
          return { entries, diagnostics: { attempts, query, source: base.name } };
        }
      } catch (error) {
        attempts.push({
          source: base.name,
          url,
          query,
          ok: false,
          parsed: 0,
          error: error?.message || String(error),
        });
      }
    }
  }

  return { entries: [], diagnostics: { attempts, query: queries[0] || "" } };
}

export async function searchOpenAlexWorks({ title = "", keywords = "", keywordBreakdown = {}, limit = 5, fetchImpl } = {}) {
  const relevanceTerms = buildRelevanceTerms({ title, keywords, keywordBreakdown });
  const requiredGroups = buildPaperRequiredGroups({ title, keywords, keywordBreakdown });
  const queries = buildBroadPaperQueries({ title, keywords, keywordBreakdown });
  if (!queries.length) return [];

  const attempts = [];
  const payloads = await Promise.all(
    queries.slice(0, 8).map(async (query) => {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query);
      url.searchParams.set("per-page", String(Math.max(limit, 8)));
      url.searchParams.set("sort", "relevance_score:desc");
      try {
        const payload = await fetchJson(url, { fetchImpl });
        const parsed = Array.isArray(payload.results) ? payload.results.length : 0;
        attempts.push({
          source: "OpenAlex",
          url: url.toString(),
          query,
          ok: parsed > 0,
          parsed,
        });
        return payload;
      } catch (error) {
        attempts.push({
          source: "OpenAlex",
          url: url.toString(),
          query,
          ok: false,
          parsed: 0,
          error: error?.message || String(error),
        });
        return { results: [] };
      }
    }),
  );

  const entries = uniqueEntries(
    payloads
      .flatMap((payload) => payload.results || [])
      .map((entry) => {
        const doi = compactText(entry.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
        const sourceUrl = entry.doi || entry.primary_location?.landing_page_url || entry.id || "";
        const abstract = invertAbstract(entry.abstract_inverted_index);
        return {
          title: compactText(entry.display_name),
          source: compactText(entry.primary_location?.source?.display_name || entry.host_venue?.display_name || "OpenAlex"),
          year: entry.publication_year ? String(entry.publication_year) : "",
          doi,
          sourceUrl,
          relevance: "待人工复核：由 OpenAlex 多检索式返回，已按题目关键词做相关性过滤。",
          innovationPoints: abstract ? [abstract.slice(0, 180)] : [],
          methodSteps: [],
        };
      })
      .filter((entry) => entry.title && entry.sourceUrl)
      .filter((entry) => hasLooseRelevantTerm(entry, relevanceTerms, requiredGroups))
      .sort((left, right) => scorePaperEntry(right, requiredGroups, relevanceTerms) - scorePaperEntry(left, requiredGroups, relevanceTerms)),
    limit,
  );
  entries.diagnostics = { attempts, query: queries[0] || "", source: "OpenAlex" };
  return entries;
}

export async function searchSemanticScholarWorks({
  title = "",
  keywords = "",
  keywordBreakdown = {},
  limit = 5,
  fetchImpl,
} = {}) {
  const relevanceTerms = buildRelevanceTerms({ title, keywords, keywordBreakdown });
  const requiredGroups = buildPaperRequiredGroups({ title, keywords, keywordBreakdown });
  const queries = buildBroadPaperQueries({ title, keywords, keywordBreakdown });
  const query = queries[0] || "";
  if (!query) return { entries: [], diagnostics: { attempts: [], query: "" } };

  const attempts = [];
  const collected = [];
  for (const currentQuery of queries.slice(0, 4)) {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", currentQuery);
    url.searchParams.set("limit", String(Math.max(limit, 8)));
    url.searchParams.set("fields", "title,year,venue,url,abstract,authors,externalIds,publicationTypes");
    try {
      const payload = await fetchJson(url, { fetchImpl });
    const rawEntries = Array.isArray(payload.data) ? payload.data : [];
    attempts.push({
      source: "Semantic Scholar",
      url: url.toString(),
      query: currentQuery,
      ok: rawEntries.length > 0,
      parsed: rawEntries.length,
    });
      collected.push(...rawEntries);
      if (collected.length >= limit) break;
    } catch (error) {
      attempts.push({
        source: "Semantic Scholar",
        url: url.toString(),
        query: currentQuery,
        ok: false,
        parsed: 0,
        error: error?.message || String(error),
      });
      if (/Too Many Requests|429/i.test(error?.message || "")) break;
    }
  }

  const entries = uniqueEntries(
    collected
        .map((entry) => {
          const doi = compactText(entry.externalIds?.DOI || "");
          return {
            title: compactText(entry.title),
            source: compactText(entry.venue || "Semantic Scholar"),
            year: entry.year ? String(entry.year) : "",
            doi,
            sourceUrl: entry.url || (doi ? `https://doi.org/${doi}` : ""),
            relevance: "待人工复核：由 Semantic Scholar 开放 API 返回，已按题目关键词做相关性过滤。",
            innovationPoints: entry.abstract ? [compactText(entry.abstract).slice(0, 220)] : [],
            methodSteps: [],
          };
        })
        .filter((entry) => entry.title && entry.sourceUrl)
        .filter((entry) => hasLooseRelevantTerm(entry, relevanceTerms, requiredGroups))
        .sort((left, right) => scorePaperEntry(right, requiredGroups, relevanceTerms) - scorePaperEntry(left, requiredGroups, relevanceTerms)),
      limit,
    );
    return { entries, diagnostics: { attempts, query, source: "Semantic Scholar" } };
}

export async function searchOpenPaperApis({ title = "", keywords = "", keywordBreakdown = {}, limit = 5, fetchImpl } = {}) {
  const [openAlexResult, semanticResult] = await Promise.allSettled([
    searchOpenAlexWorks({ title, keywords, keywordBreakdown, limit, fetchImpl }),
    searchSemanticScholarWorks({ title, keywords, keywordBreakdown, limit, fetchImpl }),
  ]);
  const openAlexEntries = openAlexResult.status === "fulfilled" ? openAlexResult.value : [];
  const semanticPayload = semanticResult.status === "fulfilled" ? semanticResult.value : { entries: [], diagnostics: { attempts: [] } };
  const entries = uniqueEntries([...(openAlexEntries || []), ...(semanticPayload.entries || [])], limit);
  const attempts = [
    ...(openAlexEntries?.diagnostics?.attempts || [
      {
        source: "OpenAlex",
        ok: openAlexResult.status === "fulfilled",
        parsed: openAlexEntries?.length || 0,
        error: openAlexResult.status === "rejected" ? openAlexResult.reason?.message || String(openAlexResult.reason) : "",
      },
    ]),
    ...(semanticPayload.diagnostics?.attempts || []),
  ];
  return {
    entries,
    diagnostics: {
      source: "OpenAlex + Semantic Scholar",
      query: openAlexEntries?.diagnostics?.query || semanticPayload.diagnostics?.query || buildPaperQuery({ title, keywords, keywordBreakdown }),
      attempts,
    },
  };
}

function pickFirstValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], source);
    if (Array.isArray(value) && value.length) return value;
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return "";
}

function pickPatentId(source = {}) {
  return compactText(
    pickFirstValue(source, [
      "patent_id",
      "patentId",
      "patent_id__",
      "patentID",
      "id",
      "pid",
    ]),
  );
}

function pickPublicationNumber(source = {}) {
  return compactText(
    pickFirstValue(source, [
      "publicationNumber",
      "publication_number",
      "publicationNo",
      "publication_no",
      "pubNo",
      "pub_no",
      "patentNumber",
      "patent_number",
      "patentPn",
      "patent_pn",
      "pn",
    ]),
  );
}

function buildPatsnapDetailBody(item = {}) {
  return {
    patent_id: pickPatentId(item) || undefined,
    patent_number: pickPublicationNumber(item) || undefined,
    replace_by_related: "0",
  };
}

function pickUrlFromPayload(payload = {}) {
  const direct = pickFirstValue(payload, [
    "data.pdf_url",
    "data.pdfUrl",
    "data.url",
    "data.link",
    "data.path",
    "data.file_url",
    "data.fileUrl",
    "data.0.pdf_url",
    "data.0.pdfUrl",
    "data.0.url",
    "data.0.link",
    "data.0.path",
    "data.0.file_url",
    "data.0.fileUrl",
    "data.0.pdf.path",
    "data.0.pdf.url",
    "data.pdf.path",
    "data.pdf.url",
    "pdf_url",
    "pdfUrl",
    "url",
    "link",
    "path",
    "file_url",
    "fileUrl",
  ]);
  if (direct) return compactText(direct);
  const text = extractPatentTextPayload(payload);
  return compactText(text.match(/https?:\/\/[^\s"'<>]+/i)?.[0] || "");
}

function isPatentDetailErrorText(value = "") {
  const text = compactText(value);
  return !text || /^API need a true rate!?$/i.test(text) || /^no data$/i.test(text) || /^null$/i.test(text);
}

function normalizePatsnapError(payload = {}, fallback = "") {
  const code = payload?.error_code || payload?.code || "";
  const message = compactText(payload?.error_msg || payload?.message || payload?.error || fallback);
  if (code === 67200203 || /API need a true rate/i.test(message)) {
    return "智慧芽详情接口返回 67200203：当前 API Key 对该接口没有可用速率/额度或未开通对应权限。";
  }
  return message;
}

function buildBasicPatentDataUrl(patentApi = {}, path = "", body = {}) {
  const url = buildPatentApiPathUrl(patentApi, path);
  if (!url) return "";
  const nextUrl = new URL(url);
  if (body.patent_id) nextUrl.searchParams.set("patent_id", body.patent_id);
  if (body.patent_number) nextUrl.searchParams.set("patent_number", body.patent_number);
  if (body.replace_by_related !== undefined) nextUrl.searchParams.set("replace_by_related", body.replace_by_related);
  return nextUrl.toString();
}

function pickDetailPayloadText(payload = {}, targetField = "") {
  const dataItems = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  if (targetField === "claims") {
    const claims = dataItems
      .flatMap((item) => (Array.isArray(item?.claims) ? item.claims : item?.claims ? [item.claims] : []))
      .map((claim) => (typeof claim === "string" ? claim : claim?.claim_text || claim?.claimText || claim?.text || ""))
      .map(compactText)
      .filter(Boolean);
    if (claims.length) return claims.join("\n");
  }
  if (targetField === "description") {
    const descriptions = dataItems
      .flatMap((item) => (Array.isArray(item?.description) ? item.description : item?.description ? [item.description] : []))
      .map((description) => (typeof description === "string" ? description : description?.text || description?.description_text || description?.descriptionText || ""))
      .map(compactText)
      .filter(Boolean);
    if (descriptions.length) return descriptions.join("\n");
  }
  return (
    pickFirstValue(payload, [
      `data.${targetField}`,
      `data.${targetField}Text`,
      `data.0.${targetField}`,
      `data.0.${targetField}Text`,
      targetField,
      `${targetField}Text`,
      "data.claims",
      "data.claim",
      "data.claim_text",
      "data.claimText",
      "data.claims_text",
      "data.claim_list",
      "data.0.claims",
      "data.0.claim",
      "data.0.claim_text",
      "data.0.claimText",
      "data.0.claims_text",
      "data.0.claim_list",
      "data.0.claims.0.claim_text",
      "data.0.claims.0.claimText",
      "data.0.claims.0.text",
      "data.description",
      "data.desc",
      "data.specification",
      "data.description_text",
      "data.descriptionText",
      "data.0.description",
      "data.0.desc",
      "data.0.specification",
      "data.0.description_text",
      "data.0.descriptionText",
      "data.0.description.0.text",
      "data.0.description.0.description_text",
      "data.0.description.0.descriptionText",
      "data.text",
      "data.content",
      "data.full_text",
      "data.fullText",
      "data.0.text",
      "data.0.content",
      "data.0.full_text",
      "data.0.fullText",
      "text",
      "content",
    ]) || extractPatentTextPayload(payload)
  );
}

async function enrichPatsnapBasicDataSection({
  item,
  patentApi,
  path,
  targetField,
  sourceField,
  fetchImpl,
  detailCalls,
  previousError = "",
}) {
  const body = buildPatsnapDetailBody(item);
  const url = buildBasicPatentDataUrl(patentApi, path, body);
  if (!url) return false;

  try {
    const payload = await fetchPatentJson(url, {
      headers: buildPatentApiHeaders(patentApi),
      fetchImpl,
      timeoutMs: 10000,
    });
    const payloadError = payload?.status === false ? normalizePatsnapError(payload) : "";
    const text = pickDetailPayloadText(payload, targetField);
    const cleanText = isPatentDetailErrorText(text) || payloadError ? "" : stripHtml(text);
    item[targetField] = cleanText;
    if (targetField === "pdfText") {
      item.pdfUrl = payloadError ? "" : pickUrlFromPayload(payload);
    }
    const ok = Boolean(cleanText || item.pdfUrl);
    detailCalls.push({
      patentNumber: body.patent_number || "",
      patentId: body.patent_id || "",
      field: targetField,
      sourceField,
      url,
      method: "GET",
      ok,
      requestBody: body,
      responseShape: summarizePayloadShape(payload),
      requestMeta: payload.__requestMeta || null,
      error: ok
        ? ""
        : [previousError, payloadError || (text ? `详情接口未返回正文：${compactText(text).slice(0, 80)}` : "详情接口未返回可用正文。")]
            .filter(Boolean)
            .join("；基础数据接口："),
    });
    return ok;
  } catch (error) {
    detailCalls.push({
      patentNumber: body.patent_number || "",
      patentId: body.patent_id || "",
      field: targetField,
      sourceField,
      url,
      method: "GET",
      ok: false,
      requestBody: body,
      error: [previousError, error?.message || String(error)].filter(Boolean).join("；基础数据接口："),
    });
    return false;
  }
}

function extractPatentTextPayload(payload = {}) {
  const values = [];
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = compactText(value);
      if (text && text.length > 8) values.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(payload?.data || payload);
  return unique(values).join("\n");
}

async function enrichPatsnapDetailSection({
  item,
  patentApi,
  path,
  targetField,
  sourceField,
  fallbackPath,
  fetchImpl,
  detailCalls,
}) {
  const url = buildPatentApiPathUrl(patentApi, path);
  if (!url) {
    detailCalls.push({
      field: targetField,
      ok: false,
      error: "详情接口路径为空，未发起请求。",
    });
    return;
  }
  const body = buildPatsnapDetailBody(item);
  if (!body.patent_id && !body.patent_number) {
    detailCalls.push({
      field: targetField,
      url,
      ok: false,
      requestBody: body,
      error: "缺少 patent_id 和 patent_number，未发起详情请求。",
    });
    return;
  }

  try {
    const payload = await postJson(url, body, {
      headers: buildPatentApiHeaders(patentApi),
      fetchImpl,
      timeoutMs: 6000,
    });
    const payloadError = payload?.status === false ? normalizePatsnapError(payload) : "";
    const text = pickDetailPayloadText(payload, targetField);
    const cleanText = isPatentDetailErrorText(text) || payloadError ? "" : stripHtml(text);
    item[targetField] = cleanText;
    if (targetField === "pdfText") {
      item.pdfUrl = payloadError ? "" : pickUrlFromPayload(payload);
    }
    const ok = Boolean(cleanText || item.pdfUrl);
    detailCalls.push({
      patentNumber: body.patent_number || "",
      patentId: body.patent_id || "",
      field: targetField,
      sourceField,
      url,
      method: "POST",
      ok,
      requestBody: body,
      responseShape: summarizePayloadShape(payload),
      requestMeta: payload.__requestMeta || null,
      error: ok ? "" : payloadError || (text ? `详情接口未返回正文：${compactText(text).slice(0, 80)}` : "详情接口未返回可用正文。"),
    });
    if (!ok && fallbackPath) {
      await enrichPatsnapBasicDataSection({
        item,
        patentApi,
        path: fallbackPath,
        targetField,
        sourceField,
        fetchImpl,
        detailCalls,
        previousError: payloadError,
      });
    }
  } catch (error) {
    detailCalls.push({
      patentNumber: body.patent_number || "",
      patentId: body.patent_id || "",
      field: targetField,
      sourceField,
      url,
      method: "POST",
      ok: false,
      requestBody: body,
      error: error?.message || String(error),
    });
    if (fallbackPath) {
      await enrichPatsnapBasicDataSection({
        item,
        patentApi,
        path: fallbackPath,
        targetField,
        sourceField,
        fetchImpl,
        detailCalls,
        previousError: error?.message || String(error),
      });
    }
  }
}

async function enrichPatentDetails(flatList = [], patentApi = {}, fetchImpl) {
  const detailCalls = [];
  const targets = flatList.slice(0, 3);
  for (const item of targets) {
    const hasClaims = pickFirstValue(item, ["claims", "claim", "claimText", "claims_text", "claim_list"]);
    const hasDescription = pickFirstValue(item, ["description", "descriptionText", "summary", "abstract", "desc"]);
    if (!hasClaims) {
      await enrichPatsnapDetailSection({
        item,
        patentApi,
        path: patentApi.claimsPath || patentApi.claimPath || patentApi.detailPath || "/search/patent/claims",
        targetField: "claims",
        sourceField: "claims",
        fallbackPath: "/basic-patent-data/claim-data",
        fetchImpl,
        detailCalls,
      });
    }
    if (!hasDescription) {
      await enrichPatsnapDetailSection({
        item,
        patentApi,
        path: patentApi.descriptionPath || patentApi.specificationPath || "/search/patent/description",
        targetField: "description",
        sourceField: "description",
        fallbackPath: "/basic-patent-data/description-data",
        fetchImpl,
        detailCalls,
      });
    }
    await enrichPatsnapDetailSection({
      item,
      patentApi,
      path: patentApi.pdfPath || patentApi.fullTextPath || "/search/patent/pdf",
      targetField: "pdfText",
      sourceField: "pdf",
      fallbackPath: "/basic-patent-data/pdf-data",
      fetchImpl,
      detailCalls,
    });
  }
  return detailCalls;
}

function normalizeCommercialPatentEntry(raw = {}, patentApi = {}) {
  const publicationNumber = pickPublicationNumber(raw);
  const title = compactText(
    pickFirstValue(raw, [
      "title",
      "patentTitle",
      "patent_title",
      "inventionTitle",
      "invention_title",
      "patent_name",
      "name",
    ]),
  );
  const applicantValue = pickFirstValue(raw, [
    "applicant",
    "applicants",
    "assignee",
    "assignees",
    "currentAssignee",
    "current_assignee",
  ]);
  const applicant = Array.isArray(applicantValue)
    ? applicantValue
      .map((item) => (typeof item === "string" ? item : item?.name || item?.applicantName || item?.assigneeName || ""))
      .filter(Boolean)
      .join("；")
    : compactText(applicantValue);
  const publicationDate = compactText(
    pickFirstValue(raw, ["publicationDate", "publication_date", "pubDate", "pub_date", "pbdt", "date"]),
  );
  const abstract = compactText(pickFirstValue(raw, ["abstract", "abstractText", "description", "summary"]));
  const relevancy = compactText(pickFirstValue(raw, ["relevancy", "score"]));
  const sourceUrl = compactText(pickFirstValue(raw, ["sourceUrl", "url", "link", "patentUrl"]));
  // 尝试从更多可能的字段中抽取说明书/摘要/描述文本作为创新点候选
  const descriptionText = compactText(
    pickFirstValue(raw, [
      "description",
      "descriptionText",
      "pdfText",
      "abstract",
      "abstractText",
      "summary",
      "summaryText",
      "invention_summary",
      "inventionSummary",
      "说明书",
      "desc",
    ]),
  );

  // 尝试抽取权利要求文本
  const claimsText = compactText(
    pickFirstValue(raw, [
      "claims",
      "claim",
      "claimText",
      "claims_text",
      "claim_list",
      "claimsText",
      "independentClaims",
      "权利要求",
    ]),
  );

  // 尝试抽取方法/步骤相关字段
  const stepsText = compactText(
    pickFirstValue(raw, [
      "methodSteps",
      "method_steps",
      "procedure",
      "process",
      "steps",
      "operation_steps",
      "methods",
      "method",
    ]),
  );

  // 生成 innovationPoints：优先使用 descriptionText，否则使用 abstract
  const innovationSource = descriptionText || claimsText || abstract || "";
  const innovationPoints = innovationSource
    ? innovationSource
      .split(/\.|。|；|;/)
      .map((s) => compactText(s))
      .filter(Boolean)
      .slice(0, 3)
    : [];

  // 生成 methodSteps：优先使用 stepsText，若无则尝试从说明或权利要求中抽取有序段落
  let methodSteps = [];
  if (stepsText) {
    methodSteps = stepsText
      .split(/[\n\r;；。\.]/)
      .map((s) => compactText(s))
      .filter(Boolean)
      .slice(0, 10);
  } else if (innovationSource) {
    methodSteps = innovationSource
      .split(/步骤|步骤：|步骤：|步骤\d|步骤\s+|步骤\(\d+\)/)
      .map((s) => compactText(s))
      .filter(Boolean)
      .slice(0, 10);
  }

  // 生成 claimFocus：优先使用权利要求文本的前若干条或摘要化的要点
  let claimFocus = [];
  if (claimsText) {
    const parts = claimsText.split(/\n|\r|；|;|\d+\.|\（\d+\）|\(|\)/).map((s) => compactText(s)).filter(Boolean);
    if (parts.length) {
      claimFocus = parts.slice(0, 4);
    } else {
      claimFocus = [claimsText.slice(0, 200)];
    }
  } else if (innovationSource) {
    claimFocus = [innovationSource.slice(0, 200)];
  }

  // 如果返回里没有直接的 URL，尝试从常见嵌套字段提取或根据公开号构造备用 URL
  let finalSourceUrl = sourceUrl || "";
  const pdfUrl = compactText(pickFirstValue(raw, ["pdfUrl", "pdf_url", "pdfLink", "pdf_link", "fileUrl", "file_url"]));
  const pdfText = compactText(pickFirstValue(raw, ["pdfText", "pdf_text", "fullText", "full_text"]));
  if (!finalSourceUrl) {
    finalSourceUrl = compactText(
      pickFirstValue(raw, [
        "source_url",
        "fileUrl",
        "file_url",
        "patent_messages.0.url",
        "patent_messages.url",
        "data.patent_messages.0.url",
        "data.search_result.0.patent_messages.0.url",
        "result_url",
        "detail_url",
        "patent_url",
        "url",
      ]),
    );
  }
  if (!finalSourceUrl && publicationNumber) {
    // 如果配置为使用智慧芽（patsnap），则不要回退为 Google Patents 链接；
    // 否则保留原有的 Google Patents 便捷跳转。
    const provider = String(patentApi?.provider || "").toLowerCase();
    const baseUrl = String(patentApi?.baseUrl || "").toLowerCase();
    const allowGoogleFallback = patentApi?.allowGoogleFallback === undefined ? true : Boolean(patentApi.allowGoogleFallback);
    if (allowGoogleFallback && provider !== "patsnap" && !baseUrl.includes("zhihuiya")) {
      finalSourceUrl = `https://patents.google.com/patent/${publicationNumber}`;
    }
  }

  return {
    title,
    publicationNumber,
    applicant,
    publicationDate,
    sourceUrl: finalSourceUrl,
    pdfUrl,
    claimsText,
    descriptionText,
    pdfText,
    detailStatus: {
      hasClaims: Boolean(claimsText),
      hasDescription: Boolean(descriptionText),
      hasPdf: Boolean(pdfText || pdfUrl),
    },
    relevance: relevancy
      ? `智慧芽语义相关性：${relevancy}。待人工复核 CNIPA 公开文本、权利要求和法律状态。`
      : "待人工复核：由智慧芽/商业专利 API 返回，需核对 CNIPA 公开文本、权利要求和法律状态。",
    innovationPoints: innovationPoints.length ? innovationPoints : ["详情接口未返回可分析的说明书或权利要求文本。"],
    methodSteps: methodSteps.length ? methodSteps : ["详情接口未返回可抽取的方法步骤；请检查说明书或 PDF 全文接口。"],
    claimFocus: claimFocus.length ? claimFocus : ["详情接口未返回权利要求文本；请检查权利要求接口响应字段。"],
  };
}

function extractCommercialPatentList(payload = {}) {
  const candidates = [
    payload.results,
    payload.data?.results,
    payload.data?.search_result,
    payload.data?.patent_messages,
    payload.data?.list,
    payload.data?.items,
    payload.data?.records,
    payload.list,
    payload.items,
    payload.records,
    payload.patents,
  ];
  return candidates.find((item) => Array.isArray(item)) || [];
}

function flattenPatentSearchResults(items = []) {
  return items.flatMap((item) => {
    if (Array.isArray(item?.patent_messages)) return item.patent_messages;
    return [item];
  });
}

function clipForPrompt(value = "", limit = 2600) {
  const text = compactText(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

async function refinePatentEntryWithLlm(entry = {}, settings = {}) {
  if (!hasConfiguredLlm(settings)) return entry;
  const sourceText = [entry.claimsText, entry.descriptionText, entry.pdfText].filter(Boolean).join("\n\n");
  if (!sourceText) return entry;

  try {
    const { data } = await createJsonCompletion({
      settings,
      temperature: 0.15,
      systemPrompt: "你是中文专利代理师。只基于给定专利文本提炼信息，输出严格 JSON，不编造文本中没有的技术内容。",
      userPrompt: [
        "请根据该专利文本输出 JSON：",
        "{",
        '  "innovationPoints": ["创新点1", "创新点2"],',
        '  "methodSteps": ["步骤1", "步骤2", "步骤3"],',
        '  "claimFocus": ["权利要求焦点1", "权利要求焦点2"]',
        "}",
        "",
        `标题：${entry.title || "未知"}`,
        `公开号：${entry.publicationNumber || "未知"}`,
        `权利要求：${clipForPrompt(entry.claimsText, 2200) || "无"}`,
        `说明书：${clipForPrompt(entry.descriptionText, 2600) || "无"}`,
        `PDF 全文：${clipForPrompt(entry.pdfText, 1600) || "无"}`,
      ].join("\n"),
    });

    return {
      ...entry,
      innovationPoints: Array.isArray(data.innovationPoints) && data.innovationPoints.length ? data.innovationPoints : entry.innovationPoints,
      methodSteps: Array.isArray(data.methodSteps) && data.methodSteps.length ? data.methodSteps : entry.methodSteps,
      claimFocus: Array.isArray(data.claimFocus) && data.claimFocus.length ? data.claimFocus : entry.claimFocus,
      analysisMode: "llm",
    };
  } catch (error) {
    return {
      ...entry,
      analysisMode: "rule-based",
      analysisError: error?.message || String(error),
    };
  }
}

async function refinePatentEntries(entries = [], settings = {}) {
  const refined = [];
  for (const entry of entries) {
    refined.push(await refinePatentEntryWithLlm(entry, settings));
  }
  return refined;
}

function buildPatentApiHeaders(patentApi = {}) {
  const apiKey = String(patentApi.apiKey || "").trim();
  if (!apiKey) return {};
  if (patentApi.authType === "x-api-key") return { "x-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

function buildPatentApiUrl(patentApi = {}) {
  const baseUrl = String(patentApi.baseUrl || "").trim().replace(/\/+$/g, "");
  const searchPath = String(patentApi.searchPath || "").trim();
  if (!baseUrl || !searchPath) return "";
  if (/^https?:\/\//i.test(searchPath)) return searchPath;
  return `${baseUrl}/${searchPath.replace(/^\/+/g, "")}`;
}

function buildPatentApiPathUrl(patentApi = {}, path = "") {
  const baseUrl = String(patentApi.baseUrl || "").trim().replace(/\/+$/g, "");
  const endpointPath = String(path || "").trim();
  if (!baseUrl || !endpointPath) return "";
  if (/^https?:\/\//i.test(endpointPath)) return endpointPath;
  return `${baseUrl}/${endpointPath.replace(/^\/+/g, "")}`;
}

export function summarizePatentApiConfig(patentApi = {}) {
  const url = buildPatentApiUrl(patentApi);
  return {
    configured: Boolean(patentApi && patentApi.provider !== "none" && patentApi.apiKey && url),
    provider: patentApi?.provider || "none",
    url,
    keywordSuggestUrl: buildPatentApiPathUrl(patentApi, patentApi.keywordSuggestPath || "/search/patent/keyword-suggest"),
    authType: patentApi?.authType || "bearer",
  };
}

function buildKeywordSuggestBody({ title = "", keywords = "", keywordBreakdown = {} } = {}) {
  const keyword = buildPatentTerms({ title, keywords, keywordBreakdown }).slice(0, 6);
  return {
    keyword,
    lang: ["cn", "en"],
    type: ["synonym", "related", "hypernym"],
  };
}

function extractSuggestedKeywords(payload = {}) {
  return unique(
    (payload.data?.items || [])
      .flatMap((item) => item.keyword_list || [])
      .map((item) => compactText(item.keyword))
      .filter(Boolean),
  ).slice(0, 30);
}

export async function suggestPatentKeywords({
  title = "",
  keywords = "",
  keywordBreakdown = {},
  patentApi = {},
  fetchImpl,
} = {}) {
  const config = summarizePatentApiConfig(patentApi);
  if (!config.configured || !config.keywordSuggestUrl) {
    return {
      ok: false,
      keywords: [],
      requestBody: buildKeywordSuggestBody({ title, keywords, keywordBreakdown }),
      message: "关键词助手未配置。",
    };
  }

  const requestBody = buildKeywordSuggestBody({ title, keywords, keywordBreakdown });
  if (!requestBody.keyword.length) {
    return {
      ok: false,
      keywords: [],
      requestBody,
      message: "没有可用于关键词扩展的输入词。",
    };
  }

  const payload = await postJson(config.keywordSuggestUrl, requestBody, {
    headers: buildPatentApiHeaders(patentApi),
    fetchImpl,
  });
  return {
    ok: true,
    keywords: extractSuggestedKeywords(payload),
    requestBody,
    responseShape: summarizePayloadShape(payload),
  };
}

export async function searchCommercialPatentApi({
  title = "",
  keywords = "",
  keywordBreakdown = {},
  patentApi = {},
  suggestedKeywords = [],
  limit = 3,
  fetchImpl,
  settings = {},
} = {}) {
  const config = summarizePatentApiConfig(patentApi);
  if (!config.configured) {
    return {
      entries: [],
      requestBody: null,
      responseShape: null,
      message: "智慧芽专利 API 未完整配置。",
    };
  }

  const query = buildQuery({ title, keywords, keywordBreakdown });
  let expandedKeywords = suggestedKeywords;
  if (!expandedKeywords.length) {
    try {
      const suggestion = await suggestPatentKeywords({ title, keywords, keywordBreakdown, patentApi, fetchImpl });
      expandedKeywords = suggestion.keywords || [];
    } catch {
      expandedKeywords = [];
    }
  }
  const displayLimit = Math.max(1, Math.min(Number(limit) || 3, 3));
  const body = buildPatentRequestBody({
    provider: patentApi.provider,
    query,
    title,
    keywords,
    keywordBreakdown,
    suggestedKeywords: expandedKeywords,
    limit: Math.max(displayLimit, 8),
  });
  const searchAttempts = [];
  let payload = null;
  let rawList = [];
  let requestBody = body;
  const semanticQueries =
    patentApi.provider === "patsnap"
      ? buildPatentSemanticQueries({ title, keywords, keywordBreakdown, suggestedKeywords: expandedKeywords })
      : [body.query || query];

  for (const semanticQuery of semanticQueries.slice(0, 6)) {
    requestBody = patentApi.provider === "patsnap" ? { ...body, text: semanticQuery } : body;
    payload = await postJson(config.url, requestBody, {
      headers: buildPatentApiHeaders(patentApi),
      fetchImpl,
    });
    rawList = extractCommercialPatentList(payload);
    searchAttempts.push({
      url: config.url,
      requestBody,
      rawResultCount: rawList.length,
      responseShape: summarizePayloadShape(payload),
      requestMeta: payload?.__requestMeta || null,
    });
    if (rawList.length) break;
  }
  let flatList = flattenPatentSearchResults(rawList).slice(0, displayLimit);
  const detailCalls = await enrichPatentDetails(flatList, patentApi, fetchImpl);

  const entries = flatList
    .map((r) => normalizeCommercialPatentEntry(r, patentApi))
    .filter((entry) => entry.title && (entry.publicationNumber || entry.sourceUrl))
    .slice(0, displayLimit);
  for (const entry of entries) {
    const successfulFields = new Set(
      detailCalls
        .filter((call) => call.patentNumber && call.patentNumber === entry.publicationNumber && call.ok)
        .map((call) => call.field || call.sourceField || ""),
    );
    entry.detailErrors = detailCalls
      .filter((call) => call.patentNumber && call.patentNumber === entry.publicationNumber && !call.ok && !successfulFields.has(call.field || call.sourceField || ""))
      .map((call) => {
        const requestId = call.requestMeta?.requestId ? `；Request-ID：${call.requestMeta.requestId}` : "";
        const correlationId = call.requestMeta?.correlationId ? `；Correlation-ID：${call.requestMeta.correlationId}` : "";
        return `${call.field || "detail"}：${call.error || "详情接口失败"}${requestId}${correlationId}`;
      });
  }
  const refinedEntries = await refinePatentEntries(entries, settings);
  return {
    entries: refinedEntries,
    requestBody,
    responseShape: summarizePayloadShape(payload),
    rawPayload: payload,
    searchAttempts,
    detailCalls,
    rawResultCount: extractCommercialPatentList(payload).length,
    totalSearchResultCount: payload?.data?.total_search_result_count ?? payload?.data?.result_count ?? "",
  };
}

export async function testCommercialPatentApi({ patentApi = {}, query = "电池 热失控 预警", fetchImpl } = {}) {
  const startedAt = Date.now();
  const config = summarizePatentApiConfig(patentApi);
  if (!config.configured) {
    return {
      ok: false,
      ...config,
      query,
      count: 0,
      elapsedMs: 0,
      message: "专利 API 未配置完整：需要平台、API Key、Base URL 和检索路径。",
    };
  }

  try {
    const suggestion = await suggestPatentKeywords({
      title: query,
      keywords: query,
      patentApi,
      fetchImpl,
    }).catch((error) => ({
      ok: false,
      keywords: [],
      message: error?.message || "关键词助手调用失败。",
    }));
    const requestBody = buildPatentRequestBody({
      provider: patentApi.provider,
      query,
      title: query,
      keywords: query,
      suggestedKeywords: suggestion.keywords || [],
      limit: 3,
    });
    const payload = await postJson(config.url, requestBody, {
      headers: buildPatentApiHeaders(patentApi),
      fetchImpl,
    });
    const rawList = extractCommercialPatentList(payload);
    let flatList = flattenPatentSearchResults(rawList);
    const detailCalls = await enrichPatentDetails(flatList, patentApi, fetchImpl);

    const entries = flatList
      .map((r) => normalizeCommercialPatentEntry(r, patentApi))
      .filter((entry) => entry.title && (entry.publicationNumber || entry.sourceUrl))
      .slice(0, 3);

    return {
      ok: true,
      ...config,
      query,
      keywordSuggestion: suggestion,
      requestBody,
      responseShape: summarizePayloadShape(payload),
      rawPayload: payload,
      detailCalls,
      count: entries.length,
      elapsedMs: Date.now() - startedAt,
      sample: entries.map((entry) => ({
        title: entry.title,
        publicationNumber: entry.publicationNumber,
        applicant: entry.applicant,
        sourceUrl: entry.sourceUrl,
      })),
      message: entries.length
        ? "专利 API 已调用并解析到结果。"
        : "专利 API 已调用，但没有解析到可展示结果；请查看请求体和响应结构摘要。",
    };
  } catch (error) {
    return {
      ok: false,
      ...config,
      query,
      requestBody: buildPatentRequestBody({
        provider: patentApi.provider,
        query,
        title: query,
        keywords: query,
        limit: 3,
      }),
      count: 0,
      elapsedMs: Date.now() - startedAt,
      message: error?.message || "专利 API 调用失败。",
    };
  }
}

export async function searchPriorArt({ title = "", keywords = "", keywordBreakdown = {}, patentApi = {}, settings = {}, fetchImpl } = {}) {
  const patentApiSummary = summarizePatentApiConfig(patentApi);
  const patentQuery = buildQuery({ title, keywords, keywordBreakdown });
  const keywordSuggestionResult = await withTimeout(
    suggestPatentKeywords({
      title,
      keywords,
      keywordBreakdown,
      patentApi,
      fetchImpl,
    }),
    INTERACTIVE_KEYWORD_TIMEOUT_MS,
    "智慧芽关键词助手响应较慢，已跳过扩词并继续检索。",
  ).catch((error) => ({
    ok: false,
    keywords: [],
    message: error?.message || "关键词助手调用失败。",
  }));
  const patentRequestBody = buildPatentRequestBody({
    provider: patentApi.provider,
    query: patentQuery,
    title,
    keywords,
    keywordBreakdown,
    suggestedKeywords: keywordSuggestionResult.keywords || [],
    limit: 3,
  });
  const [paperResult, commercialPatentResult] = await Promise.allSettled([
    withTimeout(
      searchOpenPaperApis({ title, keywords, keywordBreakdown, fetchImpl }),
      INTERACTIVE_PAPER_TIMEOUT_MS,
      "论文检索响应较慢，已先返回本地整理结果；可稍后重试或人工核验论文来源。",
    ),
    withTimeout(
      searchCommercialPatentApi({
        title,
        keywords,
        keywordBreakdown,
        patentApi,
        suggestedKeywords: keywordSuggestionResult.keywords || [],
        fetchImpl,
        settings,
      }),
      INTERACTIVE_PATENT_TIMEOUT_MS,
      "智慧芽专利检索响应较慢，已先返回本地整理结果；请稍后重试或检查 API 网络。",
    ),
  ]);
  const paperSearch = paperResult.status === "fulfilled" ? paperResult.value : {};
  const paperEntries = paperSearch.entries || [];
  let finalPaperEntries = paperEntries;
  let paperFallbackNote = "";
  if (!finalPaperEntries.length) {
    try {
      const scholarSearch = await searchGoogleScholarWorks({ title, keywords, keywordBreakdown, fetchImpl }).catch(() => ({
        entries: [],
        diagnostics: { attempts: [] },
      }));
      if (scholarSearch.entries?.length) {
        finalPaperEntries = scholarSearch.entries;
        paperFallbackNote = "开放论文 API 未命中，已使用 Google Scholar / 熊猫学术页面解析作为辅助来源。";
        paperSearch.diagnostics = {
          ...(paperSearch.diagnostics || {}),
          attempts: [...(paperSearch.diagnostics?.attempts || []), ...(scholarSearch.diagnostics?.attempts || [])],
          source: scholarSearch.diagnostics?.source || "Google Scholar / 熊猫学术",
          query: scholarSearch.diagnostics?.query || paperSearch.diagnostics?.query,
        };
      }
    } catch (e) {
      // ignore
    }
  }
  const commercialPatentSearch = commercialPatentResult.status === "fulfilled" ? commercialPatentResult.value : {};
  const commercialPatentEntries = commercialPatentSearch.entries || [];
  const refinedPaperEntries = await refinePaperEntries(finalPaperEntries, settings);

  return {
    paperEntries: refinedPaperEntries,
    paperFallbackNote,
    patentEntries: commercialPatentEntries,
    patentSearchUrl: "",
    patentSearchPortals: {},
    warnings: [
      paperResult.status === "rejected" ? `论文检索失败：${paperResult.reason?.message || paperResult.reason}` : "",
      commercialPatentResult.status === "rejected"
        ? `智慧芽专利 API 检索失败：${commercialPatentResult.reason?.message || commercialPatentResult.reason}`
        : "",
      patentApiSummary.configured && commercialPatentResult.status === "fulfilled" && !commercialPatentEntries.length
        ? `智慧芽专利 API 已调用：${patentApiSummary.url}，但未解析到可展示专利；请查看诊断里的请求体和响应结构。`
        : "",
      !patentApiSummary.configured ? "智慧芽专利 API 未完整配置；当前不会使用任何其他专利检索源兜底。" : "",
      paperResult.status === "fulfilled" && !paperEntries.length
        ? paperFallbackNote || "论文检索已尝试 OpenAlex、Semantic Scholar，并辅助尝试 Scholar 页面解析，但没有解析到可展示论文；请查看诊断里的请求 URL、错误和解析数量。"
        : "",
    ].filter(Boolean),
    diagnostics: {
      patentApi: {
        ...patentApiSummary,
        requestBody: commercialPatentSearch.requestBody || patentRequestBody,
        queryText: patentRequestBody.text || patentRequestBody.query || patentQuery,
        keywordSuggestion: keywordSuggestionResult,
        responseShape: commercialPatentSearch.responseShape || null,
        responseRaw: commercialPatentSearch.rawPayload || null,
        searchAttempts: commercialPatentSearch.searchAttempts || [],
        detailCalls: commercialPatentSearch.detailCalls || [],
        rawResultCount: commercialPatentSearch.rawResultCount ?? 0,
        totalSearchResultCount: commercialPatentSearch.totalSearchResultCount ?? "",
        returnedEntries: commercialPatentEntries.length,
        fallbackEntries: 0,
        sourcePolicy: "智慧芽 P070 扩词 + P008 语义检索；不使用其他专利来源兜底。",
      },
      paperQuery: buildPaperQuery({ title, keywords, keywordBreakdown }),
      paperSearch: {
        provider: paperSearch.diagnostics?.source || "OpenAlex + Semantic Scholar",
        query: paperSearch.diagnostics?.query || buildPaperQuery({ title, keywords, keywordBreakdown }),
        attempts: paperSearch.diagnostics?.attempts || [],
        returnedEntries: refinedPaperEntries.length,
      },
    },
  };
}


