import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const settingsDir = path.join(__dirname, "..", ".local");
const settingsPath = path.join(settingsDir, "app-settings.json");

export const defaultAppSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  patentApi: {
    provider: "none",
    apiKey: "",
    baseUrl: "https://connect.zhihuiya.com",
    searchPath: "/search/patent/semantic-search-patent/v2",
    keywordSuggestPath: "/search/patent/keyword-suggest",
    claimsPath: "/search/patent/claims",
    descriptionPath: "/search/patent/description",
    pdfPath: "/search/patent/pdf",
    authType: "bearer",
  },
};

export function normalizeBaseUrl(value = "") {
  let baseUrl = String(value || "").trim().replace(/\/+$/g, "");
  baseUrl = baseUrl.replace(/\/(chat\/completions|responses)$/i, "");

  if (!baseUrl) {
    return defaultAppSettings.baseUrl;
  }

  if (/^https:\/\/api\.openai\.com$/i.test(baseUrl)) {
    return `${baseUrl}/v1`;
  }

  return baseUrl;
}

export function normalizeSettings(input = {}) {
  const patentApi = input.patentApi && typeof input.patentApi === "object" ? input.patentApi : {};
  const provider = String(patentApi.provider || "none").trim() || "none";
  const defaultSearchPath =
    provider === "patsnap" ? defaultAppSettings.patentApi.searchPath : defaultAppSettings.patentApi.searchPath;
  const rawSearchPath = String(patentApi.searchPath || "").trim();
  const normalizedSearchPath =
    provider === "patsnap" && (!rawSearchPath || /\/search\/patent\/query-search$/i.test(rawSearchPath))
      ? defaultAppSettings.patentApi.searchPath
      : rawSearchPath || defaultSearchPath;
  return {
    apiKey: String(input.apiKey || "").trim(),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    model: String(input.model || defaultAppSettings.model).trim() || defaultAppSettings.model,
    patentApi: {
      provider,
      apiKey: String(patentApi.apiKey || "").trim(),
      baseUrl: String(patentApi.baseUrl || defaultAppSettings.patentApi.baseUrl).trim().replace(/\/+$/g, ""),
      searchPath: normalizedSearchPath,
      keywordSuggestPath: String(
        patentApi.keywordSuggestPath || defaultAppSettings.patentApi.keywordSuggestPath,
      ).trim(),
      claimsPath: String(
        patentApi.claimsPath || patentApi.claimPath || defaultAppSettings.patentApi.claimsPath,
      ).trim(),
      descriptionPath: String(
        patentApi.descriptionPath || patentApi.specificationPath || defaultAppSettings.patentApi.descriptionPath,
      ).trim(),
      pdfPath: String(patentApi.pdfPath || patentApi.fullTextPath || defaultAppSettings.patentApi.pdfPath).trim(),
      authType: String(patentApi.authType || "bearer").trim() || "bearer",
    },
  };
}

export async function loadSettings() {
  try {
    const raw = await readFile(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...defaultAppSettings };
  }
}

export async function saveSettings(input = {}) {
  const settings = normalizeSettings(input);
  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

export function summarizeSettings(settings = {}) {
  const normalized = normalizeSettings(settings);
  const hasApiKey = Boolean(normalized.apiKey);
  const hasPatentApiKey = Boolean(normalized.patentApi.apiKey);
  const patentApiConfigured =
    normalized.patentApi.provider !== "none" &&
    hasPatentApiKey &&
    Boolean(normalized.patentApi.baseUrl) &&
    Boolean(normalized.patentApi.searchPath);
  return {
    hasApiKey,
    configured: hasApiKey && Boolean(normalized.baseUrl) && Boolean(normalized.model),
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    apiKeyPreview: hasApiKey ? `${normalized.apiKey.slice(0, 4)}...${normalized.apiKey.slice(-4)}` : "",
    patentApi: {
      provider: normalized.patentApi.provider,
      configured: patentApiConfigured,
      baseUrl: normalized.patentApi.baseUrl,
      searchPath: normalized.patentApi.searchPath,
      keywordSuggestPath: normalized.patentApi.keywordSuggestPath,
      claimsPath: normalized.patentApi.claimsPath,
      descriptionPath: normalized.patentApi.descriptionPath,
      pdfPath: normalized.patentApi.pdfPath,
      authType: normalized.patentApi.authType,
      apiKeyPreview: hasPatentApiKey ? `${normalized.patentApi.apiKey.slice(0, 4)}...${normalized.patentApi.apiKey.slice(-4)}` : "",
    },
  };
}
