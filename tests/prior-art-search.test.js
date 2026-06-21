import test from "node:test";
import assert from "node:assert/strict";
import {
  searchCommercialPatentApi,
  searchGoogleScholarWorks,
  searchOpenAlexWorks,
  searchOpenPaperApis,
  searchPriorArt,
  searchSemanticScholarWorks,
  suggestPatentKeywords,
  testCommercialPatentApi,
} from "../src/prior-art-search.js";

const patsnapApi = {
  provider: "patsnap",
  apiKey: "sk-test",
  baseUrl: "https://connect.zhihuiya.com",
  searchPath: "/search/patent/semantic-search-patent/v2",
  keywordSuggestPath: "/search/patent/keyword-suggest",
  authType: "bearer",
};

function createOpenAlexMockFetch() {
  return async (url) => {
    const href = String(url);
    if (href.includes("openalex.org")) {
      return {
        ok: true,
        async json() {
          return {
            results: [
              {
                display_name: "Battery thermal runaway early warning with multimodal sensing",
                publication_year: 2024,
                doi: "https://doi.org/10.1234/example",
                primary_location: {
                  landing_page_url: "https://example.org/paper",
                  source: { display_name: "Example Journal" },
                },
                abstract_inverted_index: {
                  Battery: [0],
                  thermal: [1],
                  runaway: [2],
                  warning: [3],
                },
              },
            ],
          };
        },
      };
    }

    throw new Error(`Unexpected URL: ${href}`);
  };
}

function createOpenPaperApiMockFetch() {
  return async (url) => {
    const href = String(url);
    if (href.includes("openalex.org")) {
      return {
        ok: true,
        async json() {
          return {
            results: [
              {
                display_name: "Battery thermal runaway early warning with multimodal sensing",
                publication_year: 2024,
                doi: "https://doi.org/10.1234/example",
                primary_location: {
                  landing_page_url: "https://example.org/paper",
                  source: { display_name: "Example Journal" },
                },
                abstract_inverted_index: {
                  Battery: [0],
                  thermal: [1],
                  runaway: [2],
                  warning: [3],
                },
              },
            ],
          };
        },
      };
    }
    if (href.includes("semanticscholar.org")) {
      return {
        ok: true,
        async json() {
          return {
            data: [
              {
                title: "Multimodal thermal runaway warning for lithium batteries",
                year: 2023,
                venue: "Semantic Battery Journal",
                url: "https://www.semanticscholar.org/paper/example",
                abstract: "Battery thermal runaway warning using gas and temperature signals.",
                externalIds: { DOI: "10.5678/semantic" },
              },
            ],
          };
        },
      };
    }
    throw new Error(`Unexpected URL: ${href}`);
  };
}

function scholarHtml({ title = "BERT sentiment analysis for reviews", url = "https://example.org/paper" } = {}) {
  return `
    <html><body>
      <div class="gs_r gs_or gs_scl">
        <div class="gs_ri">
          <h3 class="gs_rt"><a href="${url}">${title}</a></h3>
          <div class="gs_a">A Author - Journal of Sentiment Computing, 2024</div>
          <div class="gs_rs">This paper uses BERT for sentiment analysis and sentiment classification.</div>
        </div>
      </div>
    </body></html>
  `;
}

function createPatsnapMockFetch({ patentResults = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: href, body, headers: options.headers || {} });

    if (href.includes("scholar.google.com") || href.includes("sc.panda985.com")) {
      return {
        ok: true,
        async text() {
          return scholarHtml({ title: "BERT sentiment analysis for battery warning text" });
        },
      };
    }

    if (href.includes("openalex.org")) {
      return {
        ok: true,
        async json() {
          return { results: [] };
        },
      };
    }

    if (href.includes("semanticscholar.org")) {
      return {
        ok: true,
        async json() {
          return { data: [] };
        },
      };
    }

    if (href === "https://connect.zhihuiya.com/search/patent/keyword-suggest") {
      return {
        ok: true,
        async json() {
          return {
            data: {
              items: [
                {
                  input: "battery",
                  keyword_list: [{ keyword: "lithium battery" }, { keyword: "thermal abuse" }],
                },
              ],
            },
            status: true,
            error_code: 0,
          };
        },
      };
    }

    if (href === "https://connect.zhihuiya.com/search/patent/semantic-search-patent/v2") {
      return {
        ok: true,
        async json() {
          return {
            data: {
              results: patentResults,
              result_count: patentResults.length,
              total_search_result_count: patentResults.length,
            },
            status: true,
            error_code: 0,
          };
        },
      };
    }

    if (href === "https://connect.zhihuiya.com/search/patent/claims") {
      return {
        ok: true,
        async json() {
          return { data: { claims: "1. A battery warning method, comprising collecting temperature and gas signals." } };
        },
      };
    }

    if (href === "https://connect.zhihuiya.com/search/patent/description") {
      return {
        ok: true,
        async json() {
          return { data: { description: "The specification describes thermal runaway prediction using multi-sensor fusion." } };
        },
      };
    }

    if (href === "https://connect.zhihuiya.com/search/patent/pdf") {
      return {
        ok: true,
        async json() {
          return { data: { text: "PDF full text contains implementation examples and protection details." } };
        },
      };
    }

    if (href.startsWith("https://connect.zhihuiya.com/basic-patent-data/claim-data")) {
      return {
        ok: true,
        async json() {
          return { data: [{ claims: [{ claim_text: "1. A fallback battery warning method, comprising collecting temperature signals." }] }] };
        },
      };
    }

    if (href.startsWith("https://connect.zhihuiya.com/basic-patent-data/description-data")) {
      return {
        ok: true,
        async json() {
          return { data: [{ description: [{ text: "Fallback specification describes multi-sensor warning steps." }] }] };
        },
      };
    }

    if (href.startsWith("https://connect.zhihuiya.com/basic-patent-data/pdf-data")) {
      return {
        ok: true,
        async json() {
          return { data: [{ pdf: { path: "https://open.zhihuiya.com/pdf/example.pdf" } }] };
        },
      };
    }

    throw new Error(`Unexpected URL: ${href}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("searchOpenAlexWorks returns papers with source links", async () => {
  const entries = await searchOpenAlexWorks({
    title: "battery thermal runaway warning",
    fetchImpl: createOpenAlexMockFetch(),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Battery thermal runaway early warning with multimodal sensing");
  assert.equal(entries[0].sourceUrl, "https://doi.org/10.1234/example");
  assert.equal(entries[0].doi, "10.1234/example");
});

test("searchSemanticScholarWorks returns papers from open API", async () => {
  const result = await searchSemanticScholarWorks({
    title: "battery thermal runaway warning",
    fetchImpl: createOpenPaperApiMockFetch(),
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, "Multimodal thermal runaway warning for lithium batteries");
  assert.equal(result.entries[0].doi, "10.5678/semantic");
  assert.equal(result.diagnostics.source, "Semantic Scholar");
});

test("searchOpenPaperApis merges OpenAlex and Semantic Scholar", async () => {
  const result = await searchOpenPaperApis({
    title: "battery thermal runaway warning",
    fetchImpl: createOpenPaperApiMockFetch(),
  });

  assert.equal(result.entries.length, 2);
  assert.equal(result.diagnostics.source, "OpenAlex + Semantic Scholar");
  assert.ok(result.diagnostics.attempts.some((attempt) => attempt.source === "OpenAlex"));
  assert.ok(result.diagnostics.attempts.some((attempt) => attempt.source === "Semantic Scholar"));
});

test("searchPriorArt returns Chinese paper summaries with method steps", async () => {
  const fetchImpl = createPatsnapMockFetch({ patentResults: [] });
  const result = await searchPriorArt({
    title: "基于bert-base-chinese模型的公共服务热线工单识别方法和系统",
    patentApi: patsnapApi,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.includes("openalex.org")) {
        return {
          ok: true,
          async json() {
            return {
              results: [
                {
                  display_name: "Research on Public Service Request Text Classification Based on BERT-BiLSTM-CNN Feature Fusion",
                  publication_year: 2024,
                  doi: "https://doi.org/10.3390/app14146282",
                  primary_location: { source: { display_name: "Applied Sciences" } },
                  abstract_inverted_index: { BERT: [0], public: [1], service: [2], request: [3], classification: [4] },
                },
              ],
            };
          },
        };
      }
      if (href.includes("semanticscholar.org")) {
        return { ok: true, async json() { return { data: [] }; } };
      }
      return fetchImpl(url, options);
    },
  });

  assert.equal(result.paperEntries.length, 1);
  assert.ok(result.paperEntries[0].titleZh.includes("公共服务请求文本分类"));
  assert.ok(result.paperEntries[0].innovationPoints[0].includes("用于"));
  assert.ok(result.paperEntries[0].methodSteps.length >= 3);
});

test("searchGoogleScholarWorks parses Google Scholar result cards", async () => {
  const calls = [];
  const result = await searchGoogleScholarWorks({
    title: "BERT sentiment analysis method",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        async text() {
          return scholarHtml({ url: "https://example.org/bert-sentiment" });
        },
      };
    },
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, "BERT sentiment analysis for reviews");
  assert.equal(result.entries[0].sourceUrl, "https://example.org/bert-sentiment");
  assert.ok(calls[0].includes("scholar.google.com"));
});

test("searchGoogleScholarWorks falls back to Panda Scholar when Google is blocked", async () => {
  const calls = [];
  const result = await searchGoogleScholarWorks({
    title: "BERT sentiment analysis method",
    fetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("scholar.google.com")) {
        return {
          ok: true,
          async text() {
            return "<html>unusual traffic captcha</html>";
          },
        };
      }
      return {
        ok: true,
        async text() {
          return scholarHtml({
            title: "Chinese BERT sentiment classification method",
            url: "https://example.org/panda-paper",
          });
        },
      };
    },
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].sourceUrl, "https://example.org/panda-paper");
  assert.ok(calls.some((href) => href.includes("scholar.google.com")));
  assert.ok(calls.some((href) => href.includes("sc.panda985.com")));
  assert.equal(result.diagnostics.attempts[0].blocked, true);
});

test("suggestPatentKeywords parses Patsnap P070 keyword-suggest response", async () => {
  const fetchImpl = createPatsnapMockFetch();
  const result = await suggestPatentKeywords({
    title: "car",
    patentApi: patsnapApi,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.keywords, ["lithium battery", "thermal abuse"]);
  assert.equal(fetchImpl.calls[0].url, "https://connect.zhihuiya.com/search/patent/keyword-suggest");
  assert.deepEqual(fetchImpl.calls[0].body.lang, ["cn", "en"]);
  assert.deepEqual(fetchImpl.calls[0].body.type, ["synonym", "related", "hypernym"]);
});

test("searchCommercialPatentApi calls Patsnap P008 semantic search and normalizes results", async () => {
  const fetchImpl = createPatsnapMockFetch({
    patentResults: [
      {
        title: "Battery thermal runaway warning method",
        pn: "CN123456789A",
        current_assignee: "Example Assignee",
        pbdt: "2025-01-01",
        relevancy: 0.92,
      },
    ],
  });

  const result = await searchCommercialPatentApi({
    title: "battery thermal runaway warning",
    patentApi: patsnapApi,
    fetchImpl,
  });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].publicationNumber, "CN123456789A");
  assert.equal(result.entries[0].applicant, "Example Assignee");
  assert.equal(result.entries[0].sourceUrl, "");
  const searchCall = fetchImpl.calls.find((call) => call.url === "https://connect.zhihuiya.com/search/patent/semantic-search-patent/v2");
  assert.equal(searchCall.headers.Authorization, "Bearer sk-test");
  assert.ok(searchCall.body.text.includes("battery thermal runaway warning"));
  assert.equal(searchCall.body.field, "RELEVANCY");
  assert.equal(searchCall.body.order, "desc");
});

test("searchCommercialPatentApi requests Patsnap detail endpoints with patent id and number", async () => {
  const fetchImpl = createPatsnapMockFetch({
    patentResults: [
      {
        title: "Battery thermal runaway warning method",
        pn: "CN108977442B",
        patent_id: "9cf648f8-8283-4767-9a14-f90f68303f3e,7353c607-0594-4592-b99e-aea9f517de17",
        current_assignee: "Example Assignee",
      },
    ],
  });
  const detailApi = {
    ...patsnapApi,
    claimsPath: "/search/patent/claims",
    descriptionPath: "/search/patent/description",
    pdfPath: "/search/patent/pdf",
  };

  const result = await searchCommercialPatentApi({
    title: "battery thermal runaway warning",
    patentApi: detailApi,
    fetchImpl,
  });

  const detailCalls = fetchImpl.calls.filter((call) => /claims|description|pdf/.test(call.url));
  assert.equal(detailCalls.length, 3);
  assert.deepEqual(detailCalls[0].body, {
    patent_id: "9cf648f8-8283-4767-9a14-f90f68303f3e,7353c607-0594-4592-b99e-aea9f517de17",
    patent_number: "CN108977442B",
    replace_by_related: "0",
  });
  assert.equal(result.detailCalls.length, 3);
  assert.ok(result.entries[0].innovationPoints.length > 0);
  assert.ok(result.entries[0].claimFocus[0].includes("battery warning method"));
});

test("searchCommercialPatentApi retries broader Patsnap semantic queries when first query is empty", async () => {
  const fetchImpl = createPatsnapMockFetch({
    patentResults: [],
  });
  let searchCount = 0;
  const retryFetch = async (url, options = {}) => {
    const href = String(url);
    if (href === "https://connect.zhihuiya.com/search/patent/semantic-search-patent/v2") {
      searchCount += 1;
      const body = JSON.parse(options.body || "{}");
      fetchImpl.calls.push({ url: href, body, headers: options.headers || {} });
      return {
        ok: true,
        async json() {
          return {
            data: {
              results:
                searchCount >= 2
                  ? [
                      {
                        title: "BERT work order classification method",
                        pn: "CN000000001A",
                        patent_id: "pid-1",
                      },
                    ]
                  : [],
              result_count: searchCount >= 2 ? 1 : 0,
              total_search_result_count: searchCount >= 2 ? 1 : 0,
            },
            status: true,
            error_code: 0,
          };
        },
      };
    }
    return fetchImpl(url, options);
  };
  retryFetch.calls = fetchImpl.calls;

  const result = await searchCommercialPatentApi({
    title: "基于bert-base-chinese模型的公共服务热线工单识别方法和系统",
    patentApi: patsnapApi,
    fetchImpl: retryFetch,
  });

  assert.equal(result.entries.length, 1);
  assert.ok(result.searchAttempts.length >= 2);
  assert.equal(result.searchAttempts[0].rawResultCount, 0);
  assert.equal(result.searchAttempts.at(-1).rawResultCount, 1);
});

test("searchCommercialPatentApi keeps mojibake fallback text out of Patsnap semantic queries", async () => {
  const fetchImpl = createPatsnapMockFetch({ patentResults: [] });
  await searchCommercialPatentApi({
    title: "基于bert-base-chinese模型的公共服务热线工单识别方法和系统",
    keywordBreakdown: {
      coreMethod: "??bert-base-chinese??????????????????。基于规则、关键词或阈值的传统处理流程",
    },
    patentApi: patsnapApi,
    fetchImpl,
  });

  const searchBodies = fetchImpl.calls
    .filter((call) => call.url === "https://connect.zhihuiya.com/search/patent/semantic-search-patent/v2")
    .map((call) => call.body.text);
  assert.ok(searchBodies.length > 0);
  assert.ok(searchBodies.every((text) => !text.includes("??")));
  assert.ok(searchBodies.every((text) => !text.includes("基于规则、关键词或阈值")));
});

test("searchCommercialPatentApi does not treat Patsnap detail error text as patent content", async () => {
  const fetchImpl = createPatsnapMockFetch({
    patentResults: [
      {
        title: "BERT work order classification method",
        pn: "CN000000002A",
        patent_id: "pid-2",
      },
    ],
  });
  const guardedFetch = async (url, options = {}) => {
    const href = String(url);
    if (/\/search\/patent\/(claims|description|pdf)|\/basic-patent-data\/(claim-data|description-data|pdf-data)/.test(href)) {
      fetchImpl.calls.push({ url: href, body: JSON.parse(options.body || "{}"), headers: options.headers || {} });
      return {
        ok: true,
        async json() {
          return { status: false, error_code: 403, error_msg: "API need a true rate!" };
        },
      };
    }
    return fetchImpl(url, options);
  };
  guardedFetch.calls = fetchImpl.calls;

  const result = await searchCommercialPatentApi({
    title: "基于bert-base-chinese模型的公共服务热线工单识别方法和系统",
    patentApi: patsnapApi,
    fetchImpl: guardedFetch,
  });

  assert.equal(result.entries[0].claimsText, "");
  assert.equal(result.entries[0].descriptionText, "");
  assert.ok(result.entries[0].innovationPoints[0].includes("详情接口未返回"));
  assert.ok(result.detailCalls.every((call) => call.ok === false));
  assert.ok(result.detailCalls[0].error.includes("67200203"));
});

test("searchCommercialPatentApi falls back to Patsnap basic patent data endpoints for details", async () => {
  const fetchImpl = createPatsnapMockFetch({
    patentResults: [
      {
        title: "BERT work order classification method",
        pn: "CN000000004A",
        patent_id: "pid-4",
      },
    ],
  });
  const fallbackFetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/search/patent/claims") || href.includes("/search/patent/description") || href.includes("/search/patent/pdf")) {
      fetchImpl.calls.push({ url: href, body: JSON.parse(options.body || "{}"), headers: options.headers || {} });
      return {
        ok: true,
        async json() {
          return { status: false, error_code: 67200203, error_msg: "API need a true rate!" };
        },
      };
    }
    return fetchImpl(url, options);
  };
  fallbackFetch.calls = fetchImpl.calls;

  const result = await searchCommercialPatentApi({
    title: "基于bert-base-chinese模型的公共服务热线工单识别方法和系统",
    patentApi: patsnapApi,
    fetchImpl: fallbackFetch,
  });

  assert.equal(result.entries.length, 1);
  assert.ok(result.entries[0].claimsText.includes("fallback battery warning method"));
  assert.ok(result.entries[0].descriptionText.includes("Fallback specification"));
  assert.equal(result.entries[0].pdfUrl, "https://open.zhihuiya.com/pdf/example.pdf");
  assert.ok(fetchImpl.calls.some((call) => call.url.startsWith("https://connect.zhihuiya.com/basic-patent-data/claim-data")));
  assert.ok(fetchImpl.calls.some((call) => call.url.startsWith("https://connect.zhihuiya.com/basic-patent-data/description-data")));
  assert.ok(fetchImpl.calls.some((call) => call.url.startsWith("https://connect.zhihuiya.com/basic-patent-data/pdf-data")));
});

test("searchCommercialPatentApi returns only three Patsnap patent entries to the frontend", async () => {
  const patentResults = Array.from({ length: 6 }, (_, index) => ({
    title: `BERT work order classification method ${index + 1}`,
    pn: `CN00000000${index + 1}A`,
    patent_id: `pid-${index + 1}`,
  }));
  const fetchImpl = createPatsnapMockFetch({ patentResults });

  const result = await searchCommercialPatentApi({
    title: "基于bert-base-chinese模型的公共服务热线工单识别方法和系统",
    patentApi: patsnapApi,
    fetchImpl,
  });

  assert.equal(result.entries.length, 3);
  assert.equal(result.detailCalls.length, 9);
  assert.deepEqual(result.entries.map((entry) => entry.publicationNumber), ["CN000000001A", "CN000000002A", "CN000000003A"]);
});

test("searchPriorArt uses open paper APIs and Patsnap P008 patents", async () => {
  const fetchImpl = createPatsnapMockFetch({ patentResults: [] });
  const result = await searchPriorArt({
    title: "battery thermal runaway warning",
    patentApi: patsnapApi,
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.includes("openalex.org")) {
        return createOpenPaperApiMockFetch()(url, options);
      }
      if (href.includes("semanticscholar.org")) {
        return createOpenPaperApiMockFetch()(url, options);
      }
      return fetchImpl(url, options);
    },
  });

  assert.equal(result.paperEntries.length, 2);
  assert.equal(result.patentEntries.length, 0);
  assert.equal(result.patentSearchUrl, "");
  assert.deepEqual(result.patentSearchPortals, {});
  assert.equal(result.diagnostics.paperSearch.returnedEntries, 2);
  assert.equal(result.diagnostics.patentApi.returnedEntries, 0);
  assert.equal(result.diagnostics.patentApi.fallbackEntries, 0);
  assert.ok(result.diagnostics.patentApi.sourcePolicy.includes("不使用其他专利来源兜底"));
  assert.ok(result.warnings.some((item) => item.includes("智慧芽专利 API 已调用")));
  assert.equal(result.diagnostics.paperSearch.provider, "OpenAlex + Semantic Scholar");
  assert.ok(fetchImpl.calls.some((call) => call.url.includes("connect.zhihuiya.com/search/patent/semantic-search-patent/v2")));
});

test("testCommercialPatentApi reports called Patsnap P008 status", async () => {
  const fetchImpl = createPatsnapMockFetch({
    patentResults: [
      {
        title: "Battery thermal runaway warning method",
        pn: "CN123456789A",
      },
    ],
  });
  const result = await testCommercialPatentApi({
    query: "battery thermal runaway warning",
    patentApi: patsnapApi,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.sample[0].publicationNumber, "CN123456789A");
  assert.ok(result.requestBody.text.includes("battery thermal runaway warning"));
  assert.equal(result.requestBody.field, "RELEVANCY");
  assert.equal(result.responseShape.data.results.type, "array");
});
