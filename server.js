import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildStyleProfile } from "./src/style-distiller.js";
import { buildBackgroundDossier } from "./src/background-generator.js";
import { searchPriorArt, testCommercialPatentApi } from "./src/prior-art-search.js";
import { buildPatentTemplate } from "./src/template-engine.js";
import { buildOfficialSourceGuides } from "./src/source-guides.js";
import { loadSampleMasters } from "./src/data-loader.js";
import { loadSettings, saveSettings, summarizeSettings } from "./src/settings-store.js";
import { createChatCompletion } from "./src/llm-client.js";
import {
  enhanceBackgroundDossier,
  enhancePatentTemplate,
  enhanceStyleProfile,
} from "./src/ai-orchestrator.js";
import {
  clearChatState,
  createChatMessage,
  createUploadedFileRecord,
  loadChatState,
  saveChatState,
} from "./src/chat-store.js";
import { generateChatReply } from "./src/chat-engine.js";
import { loadWorkspace, saveWorkspace } from "./src/workspace-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const gsapBundlePath = path.join(__dirname, "node_modules", "gsap", "dist", "gsap.min.js");
const port = Number(process.env.PORT || 3036);
const execFileAsync = promisify(execFile);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const sampleMasters = await loadSampleMasters();
const defaultLocalUser = {
  id: "default",
  username: "local",
  displayName: "本地用户",
  role: "admin",
  status: "active",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function beginNdjsonStream(response) {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
}

function writeNdjson(response, payload) {
  response.write(`${JSON.stringify(payload)}\n`);
}

function withTimeout(promise, timeoutMs, fallbackFactory) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackFactory()), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function findMasterById(masterId) {
  return sampleMasters.find((item) => item.id === masterId) || null;
}

function isTextualFile(name = "", type = "") {
  if (String(type).startsWith("text/")) {
    return true;
  }

  return /\.(txt|md|markdown|csv|json|xml|ya?ml|log|ini|cfg|html?|js|ts|tsx|jsx|py|java|c|cpp|h|hpp|sql)$/i.test(
    name,
  );
}

function sanitizeUploadFileName(value = "") {
  return String(value || "template.docx").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function runDocxExtractor(docxPath) {
  const extractorScript = path.join(__dirname, "scripts", "extract_docx_template.py");
  try {
  const { stdout, stderr } = await execFileAsync("python", ["-X", "utf8", extractorScript, docxPath], {
    cwd: __dirname,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    maxBuffer: 8 * 1024 * 1024,
  });

  const payload = JSON.parse(String(stdout || "{}"));
  if (!payload.ok) {
    throw new Error(payload.error || stderr || "docx 模板解析失败。");
  }

  return payload;
  } catch (error) {
    const stdoutText = String(error?.stdout || "").trim();
    const stderrText = String(error?.stderr || "").trim();

    for (const text of [stdoutText, stderrText]) {
      if (!text) continue;
      try {
        const payload = JSON.parse(text);
        if (payload && typeof payload === "object" && payload.error) {
          throw new Error(String(payload.error).trim());
        }
      } catch (parseError) {
        if (parseError instanceof SyntaxError) {
          continue;
        }
        throw parseError;
      }
    }

    throw new Error(stdoutText || stderrText || String(error?.message || "").trim() || "docx 模板解析失败。");
  }
}

async function extractTemplateTextFromDocx({ fileName = "", contentBase64 = "" } = {}) {
  const normalizedBase64 = String(contentBase64 || "").trim();
  if (!normalizedBase64) {
    throw new Error("缺少 docx 文件内容。");
  }

  const buffer = Buffer.from(normalizedBase64, "base64");
  if (!buffer.length) {
    throw new Error("docx 文件内容无效。");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pws-docx-"));
  const tempDocxPath = path.join(tempDir, sanitizeUploadFileName(fileName) || "template.docx");

  try {
    await writeFile(tempDocxPath, buffer);
    return await runDocxExtractor(tempDocxPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractTemplateTextFromDoc({ fileName = "", contentBase64 = "" } = {}) {
  const normalizedBase64 = String(contentBase64 || "").trim();
  if (!normalizedBase64) {
    throw new Error("缺少 doc 文件内容。");
  }

  const buffer = Buffer.from(normalizedBase64, "base64");
  if (!buffer.length) {
    throw new Error("doc 文件内容无效。");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pws-doc-"));
  const safeName = sanitizeUploadFileName(fileName) || "template.doc";
  const tempDocPath = path.join(tempDir, safeName);
  const tempDocxPath = path.join(tempDir, safeName.replace(/\.doc$/i, ".docx"));
  const converterScript = path.join(__dirname, "scripts", "convert_doc_to_docx.ps1");

  try {
    await writeFile(tempDocPath, buffer);
    const { stdout, stderr } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        converterScript,
        tempDocPath,
        tempDocxPath,
      ],
      {
        cwd: __dirname,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    const result = JSON.parse(String(stdout || "{}"));
    if (!result.ok) {
      throw new Error(result.error || stderr || "doc 转 docx 失败。");
    }

    return await runDocxExtractor(tempDocxPath);
  } catch (error) {
    const stdoutText = String(error?.stdout || "").trim();
    const stderrText = String(error?.stderr || "").trim();
    let detail = "";

    if (stdoutText) {
      try {
        const payload = JSON.parse(stdoutText);
        detail = String(payload?.error || "").trim();
      } catch {
        detail = stdoutText;
      }
    }

    const rawMessage = detail || stderrText || String(error?.message || "").trim();
    const normalizedRaw = rawMessage.toLowerCase();
    const likelyWordEnvironmentIssue =
      normalizedRaw.includes("80070520") ||
      normalizedRaw.includes("word.application") ||
      normalizedRaw.includes("com") ||
      normalizedRaw.includes("logon session") ||
      normalizedRaw.includes("登录会话") ||
      normalizedRaw.includes("microsoft word");

    if (likelyWordEnvironmentIssue) {
      throw new Error("当前环境暂时不能直接解析 .doc 文件，请先另存为 .docx 后再上传。");
    }

    throw new Error(
      rawMessage
        ? `当前环境暂时不能直接解析 .doc 文件，请先另存为 .docx 后再上传。原因为：${rawMessage}`
        : "当前环境暂时不能直接解析 .doc 文件，请先另存为 .docx 后再上传。",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractTemplateTextFromOffice({ fileName = "", contentBase64 = "" } = {}) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension === ".doc") {
    return extractTemplateTextFromDoc({ fileName, contentBase64 });
  }
  return extractTemplateTextFromDocx({ fileName, contentBase64 });
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((result, pair) => {
      const index = pair.indexOf("=");
      if (index === -1) {
        return result;
      }

      const key = pair.slice(0, index).trim();
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      result[key] = value;
      return result;
    }, {});
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", "pws_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function requireAuth() {
  return true;
}

function requireAdmin() {
  return true;
}

async function handleAuthApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    return sendJson(response, 200, {
      ok: true,
      user: defaultLocalUser,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return sendJson(response, 200, {
      ok: true,
      user: defaultLocalUser,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSessionCookie(response);
    return sendJson(response, 200, {
      ok: true,
    });
  }

  return false;
}

async function handleAdminApi(request, response, url) {
  if (!url.pathname.startsWith("/api/admin/")) {
    return false;
  }

  sendJson(response, 404, {
    message: "无角色版本不包含用户管理。",
  });
  return true;
}
async function handleSettingsApi(request, response, url, authUser) {
  if (!url.pathname.startsWith("/api/settings")) {
    return false;
  }

  if (!requireAdmin(response, authUser)) {
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    const settings = await loadSettings();
    const settingsSummary = summarizeSettings(settings);
    return sendJson(response, 200, {
      settings,
      summary: summarizeSettings(settings),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(request);
    const settings = await saveSettings(body);
    return sendJson(response, 200, {
      ok: true,
      settings,
      summary: summarizeSettings(settings),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/settings/test") {
    const body = await readJsonBody(request);
    const result = await createChatCompletion({
      settings: body,
      temperature: 0.2,
      systemPrompt: "你是一个简洁的中文专利写作助手。",
      userPrompt: "请用一句中文确认你已经连通，并说明你能帮助做专利背景整理、风格蒸馏和模板生成。",
    });

    return sendJson(response, 200, {
      ok: true,
      preview: result.text.trim(),
      summary: summarizeSettings(body),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/settings/test-patent-api") {
    const body = await readJsonBody(request);
    const settings = await saveSettings(body);
    const result = await testCommercialPatentApi({
      patentApi: settings.patentApi,
      query: body.query || "电池 热失控 预警",
    });

    return sendJson(response, result.ok ? 200 : 502, {
      ...result,
      summary: summarizeSettings(settings),
    });
  }

  sendJson(response, 404, {
    message: "设置接口不存在。",
  });
  return true;
}

async function handleWorkspaceApi(request, response, url, authUser) {
  if (!url.pathname.startsWith("/api/workspace")) {
    return false;
  }

  if (!requireAuth(response, authUser)) {
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/workspace") {
    const workspace = await loadWorkspace(authUser.id);
    return sendJson(response, 200, {
      workspace,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/workspace") {
    const body = await readJsonBody(request);
    const workspace = await saveWorkspace(authUser.id, body);
    return sendJson(response, 200, {
      ok: true,
      workspace,
    });
  }

  sendJson(response, 404, {
    message: "工作区接口不存在。",
  });
  return true;
}

async function handleTemplateApi(request, response, url, authUser) {
  if (!url.pathname.startsWith("/api/template")) {
    return false;
  }

  if (!requireAuth(response, authUser)) {
    return true;
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/api/template/extract-docx" || url.pathname === "/api/template/extract-office")
  ) {
    const body = await readJsonBody(request);
    const result = await extractTemplateTextFromOffice({
      fileName: body.fileName,
      contentBase64: body.contentBase64,
    });
    return sendJson(response, 200, result);
  }

  sendJson(response, 404, {
    message: "模板接口不存在。",
  });
  return true;
}

async function handleWorkbenchApi(request, response, url, authUser) {
  if (!url.pathname.startsWith("/api/workbench")) {
    return false;
  }

  if (!requireAuth(response, authUser)) {
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/workbench/init") {
    const settings = await loadSettings();
    return sendJson(response, 200, {
      appName: "Patent Writing Studio",
      disclaimer:
        "本站当前是本地优先版本。真实写作时，建议把你从 CNIPA、USPTO、WIPO 等官方页面整理的背景技术、实施方式和权利要求片段再导入系统继续加工。",
      sampleMasters,
      sourceGuides: buildOfficialSourceGuides("专利写作模板"),
      settingsSummary: summarizeSettings(settings),
      user: authUser,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/workbench/source-guides") {
    const body = await readJsonBody(request);
    const query = [body.title, body.keywords, body.agentName].filter(Boolean).join(" ");
    return sendJson(response, 200, {
      sourceGuides: buildOfficialSourceGuides(query),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/workbench/distill-style") {
    const body = await readJsonBody(request);
    const settings = await loadSettings();
    const baseMaster = findMasterById(body.masterId);
    const baseProfile = buildStyleProfile({
      agentName: body.agentName,
      masterName: body.masterName,
      rawText: body.rawText,
      notes: body.notes,
      seedMaster: baseMaster,
    });
    const profile = await enhanceStyleProfile({
      profile: baseProfile,
      agentName: body.agentName,
      masterName: body.masterName,
      rawText: body.rawText,
      notes: body.notes,
      settings,
    });
    return sendJson(response, 200, profile);
  }

  if (request.method === "POST" && url.pathname === "/api/workbench/generate-background") {
    const body = await readJsonBody(request);
    const settings = await loadSettings();
    const settingsSummary = summarizeSettings(settings);
    const draftBackground = buildBackgroundDossier({
      title: body.title,
      keywords: body.keywords,
      focus: body.focus,
      customPainPoints: body.customPainPoints,
    });
    const priorArt = await searchPriorArt({
      title: body.title,
      keywords: body.keywords,
      keywordBreakdown: draftBackground.keywordBreakdown,
      patentApi: settings.patentApi,
      settings,
    });
    const baseBackground = buildBackgroundDossier({
      title: body.title,
      keywords: body.keywords,
      focus: body.focus,
      customPainPoints: body.customPainPoints,
      paperEntries: priorArt.paperEntries,
      patentEntries: priorArt.patentEntries,
      patentSearchUrl: priorArt.patentSearchUrl,
      patentSearchPortals: priorArt.patentSearchPortals,
      searchWarnings: priorArt.warnings,
      searchDiagnostics: priorArt.diagnostics,
      settingsSummary,
    });
    const background = await enhanceBackgroundDossier({
      background: baseBackground,
      title: body.title,
      keywords: body.keywords,
      focus: body.focus,
      painPoints: body.customPainPoints,
      settings,
    });
    return sendJson(response, 200, background);
  }

  if (request.method === "POST" && url.pathname === "/api/workbench/generate-background-stream") {
    const body = await readJsonBody(request);
    beginNdjsonStream(response);

    try {
      const settings = await loadSettings();
      const settingsSummary = summarizeSettings(settings);
      const draftBackground = buildBackgroundDossier({
        title: body.title,
        keywords: body.keywords,
        focus: body.focus,
        customPainPoints: body.customPainPoints,
      });

      writeNdjson(response, { type: "status", stage: "draft", message: "拆题中…" });
      writeNdjson(response, { type: "partial", stage: "draft", background: draftBackground });
      writeNdjson(response, { type: "status", stage: "search", message: "正在检索真实论文和专利来源…" });

      const priorArt = await searchPriorArt({
        title: body.title,
        keywords: body.keywords,
        keywordBreakdown: draftBackground.keywordBreakdown,
        patentApi: settings.patentApi,
        settings,
      });
      const baseBackground = buildBackgroundDossier({
        title: body.title,
        keywords: body.keywords,
        focus: body.focus,
        customPainPoints: body.customPainPoints,
        paperEntries: priorArt.paperEntries,
        patentEntries: priorArt.patentEntries,
        patentSearchUrl: priorArt.patentSearchUrl,
        patentSearchPortals: priorArt.patentSearchPortals,
        searchWarnings: priorArt.warnings,
        searchDiagnostics: priorArt.diagnostics,
        settingsSummary,
      });

      writeNdjson(response, { type: "partial", stage: "search", background: baseBackground });
      writeNdjson(response, { type: "status", stage: "enhance", message: "补充论文与专利路线…" });

      const background = await withTimeout(
        enhanceBackgroundDossier({
          background: baseBackground,
          title: body.title,
          keywords: body.keywords,
          focus: body.focus,
          painPoints: body.customPainPoints,
          settings,
          timeoutMs: 8000,
        }),
        10000,
        () => ({
          ...baseBackground,
          generationMode: "rule-based",
          generationModeLabel: "已完成智慧芽检索，本地整理（LLM 增强超时）",
          generationWarning: "LLM 增强超过 10 秒，已先返回智慧芽检索结果和本地整理稿。",
        }),
      );

      writeNdjson(response, { type: "final", stage: "done", message: "整理完成", background });
    } catch (error) {
      writeNdjson(response, {
        type: "error",
        message: error?.message || "背景资料生成失败。",
      });
    } finally {
      response.end();
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/workbench/generate-template") {
    const body = await readJsonBody(request);
    const settings = await loadSettings();
    const baseMaster = body.styleProfile?.id
      ? findMasterById(body.styleProfile.id) || body.styleProfile
      : findMasterById(body.masterId);

    const styleProfile = body.styleProfile?.displayName
      ? body.styleProfile
      : await enhanceStyleProfile({
          profile: buildStyleProfile({
            masterName: body.masterName,
            rawText: body.rawText,
            seedMaster: baseMaster,
          }),
          agentName: body.agentName,
          masterName: body.masterName,
          rawText: body.rawText,
          notes: body.notes,
          settings,
        });

    const background = body.background?.title
      ? body.background
      : await enhanceBackgroundDossier({
          background: buildBackgroundDossier({
            title: body.title,
            keywords: body.keywords,
            focus: body.focus,
            customPainPoints: body.customPainPoints,
          }),
          title: body.title,
          keywords: body.keywords,
          focus: body.focus,
          painPoints: body.customPainPoints,
          settings,
        });

    const baseTemplate = buildPatentTemplate({
      title: body.title,
      keywords: body.keywords,
      patentType: body.patentType,
      styleProfile,
      background,
      leaveBlankMode: body.leaveBlankMode !== false,
      customTemplateName: body.customTemplateName,
      customTemplateContent: body.customTemplateContent,
    });

    const template = await enhancePatentTemplate({
      template: baseTemplate,
      styleProfile,
      background,
      title: body.title,
      keywords: body.keywords,
      patentType: body.patentType,
      customTemplateName: body.customTemplateName,
      settings,
    });

    return sendJson(response, 200, {
      styleProfile,
      background,
      template,
    });
  }

  sendJson(response, 404, {
    message: "工作台接口不存在。",
  });
  return true;
}

async function handleChatApi(request, response, url, authUser) {
  if (!url.pathname.startsWith("/api/chat")) {
    return false;
  }

  if (!requireAuth(response, authUser)) {
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/state") {
    const settings = await loadSettings();
    const chatState = await loadChatState(authUser.id);
    return sendJson(response, 200, {
      ...chatState,
      settingsSummary: summarizeSettings(settings),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/chat/clear") {
    const chatState = await clearChatState(authUser.id);
    return sendJson(response, 200, {
      ok: true,
      ...chatState,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/chat/upload") {
    const body = await readJsonBody(request);
    const chatState = await loadChatState(authUser.id);
    const files = Array.isArray(body.files) ? body.files : [];
    const records = files.map((file) => {
      const supported = file.supported !== false && isTextualFile(file.name, file.type);
      return createUploadedFileRecord({
        name: file.name,
        type: file.type,
        size: file.size,
        content: supported ? file.content : "",
        supported,
      });
    });
    chatState.files = [...chatState.files, ...records].slice(-20);
    await saveChatState(chatState, authUser.id);
    return sendJson(response, 200, {
      ok: true,
      files: chatState.files,
      added: records,
      messages: chatState.messages,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/chat/message") {
    const body = await readJsonBody(request);
    const message = String(body.message || "").trim();
    if (!message) {
      return sendJson(response, 400, {
        message: "消息不能为空。",
      });
    }

    const settings = await loadSettings();
    const chatState = await loadChatState(authUser.id);
    const userMessage = createChatMessage({ role: "user", content: message });
    chatState.messages.push(userMessage);

    const reply = await generateChatReply({
      message,
      history: chatState.messages,
      files: chatState.files,
      settings,
    });

    const assistantMessage = createChatMessage({
      role: "assistant",
      content: reply.content,
      meta: {
        generationMode: reply.generationMode,
        generationModeLabel: reply.generationModeLabel,
      },
    });
    chatState.messages.push(assistantMessage);
    chatState.messages = chatState.messages.slice(-40);
    await saveChatState(chatState, authUser.id);

    return sendJson(response, 200, {
      ok: true,
      messages: chatState.messages,
      files: chatState.files,
      reply: assistantMessage,
    });
  }

  sendJson(response, 404, {
    message: "聊天接口不存在。",
  });
  return true;
}

async function handleStatic(request, response, url) {
  if (url.pathname === "/vendor/gsap/gsap.min.js") {
    try {
      const file = await readFile(gsapBundlePath);
      response.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(file);
      return true;
    } catch {
      return false;
    }
  }

  const pathname =
    url.pathname === "/"
      ? "/index.html"
      : url.pathname === "/favicon.ico"
        ? "/favicon.svg"
        : url.pathname;
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden");
    return true;
  }

  try {
    const ext = path.extname(safePath);
    const file = await readFile(safePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(file);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const sessionToken = "";
  const authUser = defaultLocalUser;

  try {
    const authHandled = await handleAuthApi(request, response, url, authUser, sessionToken);
    if (authHandled !== false) {
      return;
    }

    const adminHandled = await handleAdminApi(request, response, url, authUser);
    if (adminHandled !== false) {
      return;
    }

    const settingsHandled = await handleSettingsApi(request, response, url, authUser);
    if (settingsHandled !== false) {
      return;
    }

    const workspaceHandled = await handleWorkspaceApi(request, response, url, authUser);
    if (workspaceHandled !== false) {
      return;
    }

    const templateHandled = await handleTemplateApi(request, response, url, authUser);
    if (templateHandled !== false) {
      return;
    }

    const workbenchHandled = await handleWorkbenchApi(request, response, url, authUser);
    if (workbenchHandled !== false) {
      return;
    }

    const chatHandled = await handleChatApi(request, response, url, authUser);
    if (chatHandled !== false) {
      return;
    }

    const staticHandled = await handleStatic(request, response, url);
    if (staticHandled) {
      return;
    }

    sendText(response, 404, "Not Found");
  } catch (error) {
    sendJson(response, 500, {
      error: "ServerError",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    console.error(`Run "npm run status" to see whether this project is already running.`);
    console.error(`Run "npm run stop" to free port ${port}, or start with another port like "$env:PORT=3037; npm start".`);
    process.exit(1);
  }

  throw error;
});

server.listen(port, () => {
  console.log(`Patent Writing Studio Role Auth is running at http://localhost:${port}`);
});


