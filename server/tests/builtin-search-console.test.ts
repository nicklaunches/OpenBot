import { afterEach, describe, expect, test } from "bun:test";
import type { SearchConsoleConfig } from "../src/config";
import {
  analyticsTable,
  boundedRows,
  callTool,
  dateWindow,
  defaultWindow,
  listNeedsCredential,
  listTools,
  selectDimensions,
  selectFilters,
  selectSite,
  useSearchConsole,
} from "../src/plugins/builtin-search-console";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import {
  INSPECTION_BASE,
  READONLY_SCOPE,
  redacted,
  WEBMASTERS_BASE,
} from "../src/search-console/client";

/**
 * The builtin Search Console transport, asserted without Google.
 *
 * What is under test is the boundary, not the API: which property a call is allowed to be about, what
 * URL and body actually go out, what a model is told when an argument is wrong, and how much text can
 * come back. A recording stub is installed through {@link useSearchConsole}, which is the seam this
 * module has for exactly that reason: `transportFor` resolves a kind to a MODULE, so there is no
 * constructor to pass a client to.
 *
 * The three properties this file exists for are the ones that are expensive to be wrong about. The
 * first is the site allowlist: a property that is not configured must be refused before anything is
 * decrypted, minted or requested, because the service account can very well see it and Google would
 * happily answer. The second is the credential: the key and the token are resolved per call, cached
 * only against the credential's own id, and must never appear in an answer. The third is bounding:
 * every result here goes into a model's context window, and an unbounded table is Google deciding how
 * much of it to spend.
 */

const CONNECTION = {
  url: "builtin://search-console/",
  actorId: "user_asker",
  botId: "bot_helper",
};

/**
 * Two properties, one of each spelling, which is the shape a real deployment has.
 *
 * The two spellings are not interchangeable and the connector must never turn one into the other, so
 * having both means "the configured spelling was sent" is a claim that can fail rather than one that
 * passes by having nothing to confuse it with.
 */
const DOMAIN_PROPERTY = "sc-domain:example.test";
const URL_PROPERTY = "https://shop.example.test/";

const CONFIG: SearchConsoleConfig = {
  sites: [DOMAIN_PROPERTY, URL_PROPERTY],
};

/**
 * A private key shaped like a real one, so the redaction cases exercise the forms that actually turn
 * up: the PEM with newlines, the JSON-escaped spelling, and the base64 body on its own.
 */
const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\nkYS0tLS1CRUdJTgo=\n-----END PRIVATE KEY-----\n";

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "example-project",
  client_email: "bot@example-project.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY,
});

const TOKEN = "ya29.a0-not-a-real-token-but-long-enough";

const CREDENTIAL_ID = "cred_first";

type Recorded = {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
};

type Stubs = {
  /** What Google answers, chosen by the URL that was asked for. */
  answer?: (recorded: Recorded) => Response | Promise<Response>;
  credential?: () => Promise<{ id: string; serviceAccount: string } | null>;
  mintToken?: (serviceAccount: string) => Promise<{
    token: string;
    expiresAt: number;
  }>;
  config?: SearchConsoleConfig;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Installs a Search Console whose requests are recorded rather than made.
 *
 * The credential lookups and the token mints are counted as well as the requests, because the two
 * claims worth being able to check without Google are "the key was read on this call" and "the token
 * was not minted again", and neither is visible from the answer.
 */
function recordingSearchConsole(stubs: Stubs = {}): {
  calls: Recorded[];
  unlocked: string[];
  minted: string[];
} {
  const calls: Recorded[] = [];
  const unlocked: string[] = [];
  const minted: string[] = [];

  useSearchConsole({
    config: stubs.config ?? CONFIG,
    credential: async () => {
      unlocked.push("read");
      return stubs.credential
        ? await stubs.credential()
        : { id: CREDENTIAL_ID, serviceAccount: SERVICE_ACCOUNT };
    },
    mintToken: async (serviceAccount) => {
      minted.push(serviceAccount);
      return stubs.mintToken
        ? await stubs.mintToken(serviceAccount)
        : { token: TOKEN, expiresAt: Date.now() + 3_600_000 };
    },
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const recorded: Recorded = {
        url,
        method: init?.method ?? "GET",
        authorization: headers.authorization,
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(recorded);
      return stubs.answer ? await stubs.answer(recorded) : json({});
    },
  });

  return { calls, unlocked, minted };
}

// The binding is module-level and the suite is one process, so an access left installed here would be
// the one some other file's test unexpectedly reaches. It also empties the token cache, which is what
// keeps the caching cases from leaking a token into the next one.
afterEach(() => {
  useSearchConsole(null);
});

describe("the tool list", () => {
  test("is the four Search Console tools, named exactly", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_sites",
      "search_analytics",
      "inspect_url",
      "list_sitemaps",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("requires only what a call cannot be made without", async () => {
    const required = Object.fromEntries(
      (await listTools()).map((tool) => [
        tool.name,
        (tool.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    // `list_sites` is the one that takes no property, because answering which properties there are is
    // its whole job.
    expect(required.list_sites).toEqual([]);
    expect(required.search_analytics).toEqual(["site"]);
    expect(required.inspect_url).toEqual(["site", "url"]);
    expect(required.list_sitemaps).toEqual(["site"]);
  });

  test("is answered without a credential, because the answer is in this file", async () => {
    // Assumed otherwise, an administrator is sent to connect an account purely so a token can be
    // minted, handed to a function that ignores it, and thrown away.
    expect(listNeedsCredential).toBe(false);
    const tools = await listTools();
    expect(tools.length).toBe(4);
  });

  test("names the configured properties, so a model does not have to guess a string", async () => {
    recordingSearchConsole();
    const tools = await listTools();
    for (const tool of tools) {
      if (tool.name === "list_sites") continue;
      expect(tool.description).toContain(DOMAIN_PROPERTY);
      expect(tool.description).toContain(URL_PROPERTY);
    }
  });

  test("says the two things a model cannot see: the data lag and the inspection quota", async () => {
    const tools = await listTools();
    const analytics = tools.find((tool) => tool.name === "search_analytics");
    // A window ending today reports a fall in traffic that did not happen, and a model will report it
    // as news.
    expect(analytics?.description ?? "").toContain("three days ago");
    expect(analytics?.description ?? "").toContain("lags");

    const inspect = tools.find((tool) => tool.name === "inspect_url");
    expect(inspect?.description ?? "").toContain("2000 inspections");
  });

  test("says a property is a property string rather than a domain", async () => {
    // Search Console has no "example.com": it has sc-domain:example.com and https://example.com/, and
    // a model that types the bare domain is answered by Google with a permission error about a
    // property that does not exist.
    const tools = await listTools();
    for (const tool of tools) {
      if (tool.name === "list_sites") continue;
      const site = (
        tool.inputSchema as {
          properties?: Record<string, { description?: string }>;
        }
      ).properties?.site;
      expect(site).toBeDefined();
      expect(site?.description ?? "").toContain("sc-domain:example.com");
      expect(site?.description ?? "").toContain(
        "A bare domain is not a property",
      );
    }
  });
});

describe("which property a call may be about", () => {
  test("a property this deployment did not configure is refused, and nothing is asked of Google", async () => {
    /*
     * The case this connector's whole shape exists for. The service account may very well be
     * verified for the site that was named — somebody added it to fix something and never removed it
     * — so Google would answer. The configured list is the decision; Google's answer is not.
     */
    const { calls, unlocked, minted } = recordingSearchConsole();

    const result = await callTool(CONNECTION, "search_analytics", {
      site: "sc-domain:somebody-else.test",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not one of this deployment's");
    // The refusal lists the ones that exist, so the model's next call is a correct one.
    expect(result.text).toContain(DOMAIN_PROPERTY);
    expect(result.text).toContain(URL_PROPERTY);
    // Refused before the vault, before the token and before the network, in that order.
    expect(calls).toEqual([]);
    expect(unlocked).toEqual([]);
    expect(minted).toEqual([]);
  });

  test("a missing property is refused with the list rather than defaulted", async () => {
    // Unlike the mailbox's `account`, there is no sensible default here: two properties are two
    // different sites, and picking one would answer a question about the wrong company's traffic.
    const { calls } = recordingSearchConsole();
    const result = await callTool(CONNECTION, "list_sitemaps", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Say which property");
    expect(result.text).toContain(DOMAIN_PROPERTY);
    expect(calls).toEqual([]);
  });

  test("the configured spelling is what goes out, not the caller's", async () => {
    // Tolerated on the way in, because everybody types a URL-prefix property without its trailing
    // slash and casing is not a property. What is SENT is always the string an administrator wrote.
    const { calls } = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });

    await callTool(CONNECTION, "list_sitemaps", {
      site: "HTTPS://Shop.Example.test",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${WEBMASTERS_BASE}/sites/${encodeURIComponent(URL_PROPERTY)}/sitemaps`,
    );
  });

  test("percent-encodes the property, so a URL property cannot address another endpoint", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });
    await callTool(CONNECTION, "list_sitemaps", { site: URL_PROPERTY });

    // Interpolated raw, `https://shop.example.test/` would put a scheme and two slashes inside a path
    // segment and reach something else entirely.
    expect(calls[0].url).toContain("https%3A%2F%2Fshop.example.test%2F");
    expect(calls[0].url).not.toContain("/sites/https://");
    // The colon in a domain property is encoded for the same reason.
    const domain = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    expect(domain.calls[0].url).toContain("sc-domain%3Aexample.test");
  });

  test("selectSite hands back the configured spelling and refuses anything else", () => {
    expect(
      selectSite({ site: "sc-domain:example.test" }, CONFIG.sites),
    ).toEqual({
      site: DOMAIN_PROPERTY,
    });
    expect(
      selectSite({ site: "https://shop.example.test" }, CONFIG.sites).site,
    ).toBe(URL_PROPERTY);
    expect(selectSite({ site: "example.test" }, CONFIG.sites).error).toContain(
      "not one of this deployment's",
    );
  });
});

describe("the window a search analytics call covers", () => {
  test("defaults to the 28 days ending three days ago", () => {
    /*
     * Both ends pulled back, and the end is the part that matters: Search Console's data lags, so a
     * window ending today shows a collapse in traffic that did not happen and a model reports it.
     * Asserted against a fixed clock rather than against whatever day the suite runs on.
     */
    const noon = Date.parse("2026-09-01T12:00:00Z");
    expect(defaultWindow(noon)).toEqual({
      startDate: "2026-08-02",
      endDate: "2026-08-29",
    });
  });

  test("sends that window when the call named neither end", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json({ rows: [] }),
    });
    const expected = defaultWindow();

    await callTool(CONNECTION, "search_analytics", { site: DOMAIN_PROPERTY });

    const body = calls[0].body as { startDate: string; endDate: string };
    expect(body.startDate).toBe(expected.startDate);
    expect(body.endDate).toBe(expected.endDate);
  });

  test("one end given is an answer rather than a mistake", () => {
    const window = dateWindow({ end_date: "2026-03-31" });
    expect(window.endDate).toBe("2026-03-31");
    expect(window.startDate).toBe("2026-03-04");
  });

  test("a date that is not a date is refused rather than sent on", () => {
    // Google's own complaint about one is a 400 naming a field rather than a format, and a model
    // reading it retries with the same shape.
    expect(dateWindow({ start_date: "March 1st" }).error).toContain(
      "YYYY-MM-DD",
    );
    expect(dateWindow({ start_date: "2026-02-30" }).error).toContain(
      "YYYY-MM-DD",
    );
    expect(dateWindow({ end_date: "2026-13-01" }).error).toContain(
      "YYYY-MM-DD",
    );
  });

  test("a window that runs backwards is refused, naming both ends", () => {
    const window = dateWindow({
      start_date: "2026-05-01",
      end_date: "2026-04-01",
    });
    expect(window.error).toContain("2026-05-01");
    expect(window.error).toContain("2026-04-01");
  });

  test("asks for finalised data, so incomplete days never enter a comparison", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json({ rows: [] }),
    });
    await callTool(CONNECTION, "search_analytics", { site: DOMAIN_PROPERTY });
    expect((calls[0].body as { dataState: string }).dataState).toBe("final");
  });
});

describe("what a search analytics call is broken down by", () => {
  test("defaults to query", () => {
    expect(selectDimensions({}).dimensions).toEqual(["query"]);
  });

  test("accepts a bare string and a comma-separated one", () => {
    // A model asked for an array of enums produces both of these often enough that refusing them
    // would be refusing a clear intention over a JSON type.
    expect(selectDimensions({ dimensions: "page" }).dimensions).toEqual([
      "page",
    ]);
    expect(selectDimensions({ dimensions: "query,page" }).dimensions).toEqual([
      "query",
      "page",
    ]);
  });

  test("refuses a dimension that is not one, and lists the six", () => {
    const chosen = selectDimensions({ dimensions: ["query", "keyword"] });
    expect(chosen.dimensions).toBeUndefined();
    expect(chosen.error).toContain("keyword is not a Search Console dimension");
    expect(chosen.error).toContain("searchAppearance");
  });

  test("deduplicates rather than sending a request Google answers with a 400", () => {
    expect(
      selectDimensions({ dimensions: ["query", "query", "page"] }).dimensions,
    ).toEqual(["query", "page"]);
  });

  test("a filter defaults to equals and reaches Google as one and-group", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json({ rows: [] }),
    });

    await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      filters: [
        { dimension: "country", expression: "usa" },
        { dimension: "page", operator: "contains", expression: "/blog/" },
      ],
    });

    expect(
      (calls[0].body as { dimensionFilterGroups: unknown })
        .dimensionFilterGroups,
    ).toEqual([
      {
        groupType: "and",
        filters: [
          { dimension: "country", operator: "equals", expression: "usa" },
          { dimension: "page", operator: "contains", expression: "/blog/" },
        ],
      },
    ]);
  });

  test("a filter with no group is left off the body entirely", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json({ rows: [] }),
    });
    await callTool(CONNECTION, "search_analytics", { site: DOMAIN_PROPERTY });
    expect(calls[0].body).not.toHaveProperty("dimensionFilterGroups");
  });

  test("a filter that is malformed is refused before anything is sent", async () => {
    expect(
      selectFilters({ filters: [{ dimension: "keyword", expression: "x" }] })
        .error,
    ).toContain("which is not one");
    expect(
      selectFilters({
        filters: [
          { dimension: "query", operator: "startsWith", expression: "x" },
        ],
      }).error,
    ).toContain("includingRegex");
    expect(
      selectFilters({ filters: [{ dimension: "query", expression: "  " }] })
        .error,
    ).toContain("nothing to compare against");
    expect(selectFilters({ filters: "query=x" }).error).toContain(
      "has to be a list",
    );

    const { calls } = recordingSearchConsole();
    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      filters: [{ dimension: "keyword", expression: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a search type that is not one is refused rather than quietly turned into web", async () => {
    const result = await (async () => {
      recordingSearchConsole();
      return callTool(CONNECTION, "search_analytics", {
        site: DOMAIN_PROPERTY,
        search_type: "shopping",
      });
    })();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("googleNews");
  });
});

describe("how many rows come back", () => {
  test("defaults to 50 and caps at 250, saying so rather than refusing", () => {
    // Capped rather than refused, unlike a malformed number: "give me 1000 rows" is a perfectly clear
    // intention that this tool does not serve, and refusing costs a round trip to learn a number.
    expect(boundedRows(undefined)).toEqual({ limit: 50, capped: false });
    expect(boundedRows(10)).toEqual({ limit: 10, capped: false });
    expect(boundedRows(1000)).toEqual({ limit: 250, capped: true });
  });

  test("the cap is what goes out and the answer says it was capped", async () => {
    const rows = Array.from({ length: 250 }, (_row, index) => ({
      keys: [`term ${index}`],
      clicks: 1,
      impressions: 10,
      ctr: 0.1,
      position: 5,
    }));
    const { calls } = recordingSearchConsole({ answer: () => json({ rows }) });

    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      row_limit: 1000,
    });

    expect((calls[0].body as { rowLimit: number }).rowLimit).toBe(250);
    expect(result.text).toContain("250 is the most this tool returns at once");
  });

  test("fewer rows than asked for is said, because that is the end of the data", async () => {
    recordingSearchConsole({
      answer: () =>
        json({
          rows: [
            { keys: ["one"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 },
          ],
        }),
    });

    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      row_limit: 25,
    });

    expect(result.text).toContain("returned 1 of the 25 rows asked for");
    expect(result.text).toContain("end of the data");
  });

  test("start_row is carried through and named in the answer", async () => {
    const { calls } = recordingSearchConsole({
      answer: () =>
        json({
          rows: [
            { keys: ["one"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 },
          ],
        }),
    });

    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      start_row: 50,
    });

    expect((calls[0].body as { startRow: number }).startRow).toBe(50);
    expect(result.text).toContain("from row 50");
  });

  test("a row_limit that is not a whole number is refused rather than rounded", async () => {
    recordingSearchConsole();
    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      row_limit: 12.7,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("whole number");
  });

  test("nothing found is said in words rather than returned as an empty table", async () => {
    // An empty result reads to a model as "the tool had nothing to say" and gets filled in from
    // memory, which for a connector about facts is the exact failure it exists to prevent.
    recordingSearchConsole({ answer: () => json({ rows: [] }) });
    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No search data for");
  });

  test("an enormous answer is cut visibly rather than silently", async () => {
    const rows = Array.from({ length: 250 }, (_row, index) => ({
      keys: [`${"a term that is quite long ".repeat(20)}${index}`],
      clicks: 1,
      impressions: 10,
      ctr: 0.1,
      position: 5,
    }));
    recordingSearchConsole({ answer: () => json({ rows }) });

    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      row_limit: 250,
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated:");
    expect(result.text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });
});

describe("how a search analytics answer reads", () => {
  const ROWS = [
    {
      keys: ["blue widgets"],
      clicks: 120,
      impressions: 4000,
      ctr: 0.03,
      position: 8.25,
    },
    {
      keys: ["widget prices"],
      clicks: 5,
      impressions: 1000,
      ctr: 0.005,
      position: 12.44,
    },
  ];

  test("is a table with a percentage ctr and a one-decimal position", () => {
    const rendered = analyticsTable(ROWS, ["query"]);
    const [header, rule, first, second] = rendered.split("\n");

    expect(header).toContain("query");
    expect(header).toContain("clicks");
    expect(header).toContain("impressions");
    expect(header).toContain("ctr");
    expect(header).toContain("position");
    expect(rule.startsWith("-")).toBe(true);

    // A ratio is a percentage with one decimal, which is how everybody reads and quotes a CTR.
    expect(first).toContain("3.0%");
    expect(second).toContain("0.5%");
    // A position is rounded, never carried out to the precision the average does not have.
    expect(first).toContain("8.3");
    expect(second).toContain("12.4");
  });

  test("the columns line up, so fifty rows can be scanned rather than parsed", () => {
    const lines = analyticsTable(ROWS, ["query"]).split("\n");
    // Header, rule and both rows are all one width, which is what makes a fixed-width table readable.
    const widths = new Set(lines.slice(0, 4).map((line) => line.length));
    expect(widths.size).toBeLessThanOrEqual(2);
    expect(lines[0].indexOf("clicks")).toBeGreaterThan(
      "blue widgets".length - 1,
    );
  });

  test("one column per dimension, in the order they were asked for", () => {
    const rendered = analyticsTable(
      [
        {
          keys: ["blue widgets", "https://example.test/a"],
          clicks: 1,
          impressions: 2,
          ctr: 0.5,
          position: 1,
        },
      ],
      ["query", "page"],
    );
    expect(rendered.split("\n")[0]).toMatch(/query\s+page\s+clicks/);
    expect(rendered).toContain("https://example.test/a");
  });

  test("the totals line is about the rows shown, and weights position by impressions", () => {
    /*
     * A flat mean is the standard way this metric gets misreported: a query with a thousand
     * impressions at position 4 and one with ten at position 90 do not average to 47 in any sense
     * anybody means.
     */
    const rendered = analyticsTable(ROWS, ["query"]);
    expect(rendered).toContain(
      "Totals across these 2 rows: 125 clicks, 5000 impressions",
    );
    expect(rendered).toContain("2.5% ctr");
    // (8.25 * 4000 + 12.44 * 1000) / 5000 = 9.088
    expect(rendered).toContain("average position 9.1, weighted by impressions");
  });

  test("the answer says which property, window, surface and breakdown it is about", async () => {
    // A model holding two answers in one turn cannot merge them if each says what it was.
    recordingSearchConsole({ answer: () => json({ rows: ROWS }) });
    const result = await callTool(CONNECTION, "search_analytics", {
      site: DOMAIN_PROPERTY,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
      dimensions: ["query"],
    });

    expect(result.text).toContain(DOMAIN_PROPERTY);
    expect(result.text).toContain("2026-01-01 to 2026-01-31");
    expect(result.text).toContain("web search");
    expect(result.text).toContain("by query");
  });
});

describe("list_sites", () => {
  test("asks about the configured properties one at a time and reports each permission level", async () => {
    /*
     * Not `sites.list`. That answers with everything the service account can see, which is a list
     * this deployment has not decided anybody may ask about, and it would arrive here needing to be
     * filtered anyway. Asking about the configured ones means the wider list is never in this process.
     */
    const { calls } = recordingSearchConsole({
      answer: (recorded) =>
        json({
          siteUrl: recorded.url,
          permissionLevel: recorded.url.includes("sc-domain")
            ? "siteOwner"
            : "siteFullUser",
        }),
    });

    const result = await callTool(CONNECTION, "list_sites", {});

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      `${WEBMASTERS_BASE}/sites/${encodeURIComponent(DOMAIN_PROPERTY)}`,
    );
    expect(calls[0].method).toBe("GET");
    expect(result.text).toContain(`${DOMAIN_PROPERTY} · siteOwner`);
    expect(result.text).toContain(`${URL_PROPERTY} · siteFullUser`);
  });

  test("one property the account has lost reports as itself, not as a failed call", async () => {
    // A deployment whose account lost access to one property still has a working connector for the
    // others, and the sentence says which is which.
    const { calls } = recordingSearchConsole({
      answer: (recorded) =>
        recorded.url.includes("sc-domain")
          ? json({ error: { message: "User does not have permission" } }, 403)
          : json({ permissionLevel: "siteOwner" }),
    });

    const result = await callTool(CONNECTION, "list_sites", {});

    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("User does not have permission");
    expect(result.text).toContain(`${URL_PROPERTY} · siteOwner`);
  });
});

describe("inspect_url", () => {
  const INSPECTION = {
    inspectionResult: {
      inspectionResultLink:
        "https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aexample.test",
      indexStatusResult: {
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        indexingState: "INDEXING_ALLOWED",
        lastCrawlTime: "2026-08-28T04:11:00Z",
        robotsTxtState: "ALLOWED",
        pageFetchState: "SUCCESSFUL",
        googleCanonical: "https://example.test/a",
        userCanonical: "https://example.test/a?utm=x",
        crawledAs: "MOBILE",
        sitemap: ["https://example.test/sitemap.xml"],
      },
      mobileUsabilityResult: { verdict: "PASS" },
      richResultsResult: { verdict: "NEUTRAL" },
    },
  };

  test("posts to the inspection host with the URL and the configured property", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json(INSPECTION),
    });

    await callTool(CONNECTION, "inspect_url", {
      site: DOMAIN_PROPERTY,
      url: "https://example.test/a",
    });

    // The inspection API lives on its own host and has never been backported to the v3 one.
    expect(calls[0].url).toBe(`${INSPECTION_BASE}/urlInspection/index:inspect`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      inspectionUrl: "https://example.test/a",
      siteUrl: DOMAIN_PROPERTY,
    });
  });

  test("reads out the verdict, the reason, the crawl facts and the link", async () => {
    recordingSearchConsole({ answer: () => json(INSPECTION) });
    const result = await callTool(CONNECTION, "inspect_url", {
      site: DOMAIN_PROPERTY,
      url: "https://example.test/a",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Verdict: PASS");
    expect(result.text).toContain("Coverage: Submitted and indexed");
    expect(result.text).toContain("Indexing: INDEXING_ALLOWED");
    expect(result.text).toContain("Last crawled: 2026-08-28T04:11:00Z");
    expect(result.text).toContain("robots.txt: ALLOWED");
    expect(result.text).toContain("Page fetch: SUCCESSFUL");
    expect(result.text).toContain("Mobile usability: PASS");
    expect(result.text).toContain("Rich results: NEUTRAL");
    expect(result.text).toContain("search.google.com/search-console/inspect");
  });

  test("puts the two canonicals together and says when they differ", async () => {
    // Apart, they are two URLs a model reports separately. Together, the difference is the finding,
    // and it is the most common real cause of a page that is crawled and not indexed.
    recordingSearchConsole({ answer: () => json(INSPECTION) });
    const result = await callTool(CONNECTION, "inspect_url", {
      site: DOMAIN_PROPERTY,
      url: "https://example.test/a",
    });
    expect(result.text).toContain("they differ");
    expect(result.text).toContain("https://example.test/a?utm=x");
  });

  test("says nothing about fields Google said nothing about", async () => {
    // A page of "unknown" reads to a model as a tool that failed.
    recordingSearchConsole({
      answer: () =>
        json({
          inspectionResult: {
            indexStatusResult: {
              verdict: "NEUTRAL",
              coverageState: "Discovered",
            },
          },
        }),
    });
    const result = await callTool(CONNECTION, "inspect_url", {
      site: DOMAIN_PROPERTY,
      url: "https://example.test/b",
    });
    expect(result.text).toContain("Coverage: Discovered");
    expect(result.text).not.toContain("Last crawled");
    expect(result.text).not.toContain("Mobile usability");
  });

  test("refuses a call with no URL before anything is sent", async () => {
    const { calls } = recordingSearchConsole();
    const result = await callTool(CONNECTION, "inspect_url", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Say which URL to inspect");
    expect(calls).toEqual([]);
  });
});

describe("list_sitemaps", () => {
  test("reads out each sitemap's timestamps, state, counts and contents", async () => {
    recordingSearchConsole({
      answer: () =>
        json({
          sitemap: [
            {
              path: "https://example.test/sitemap.xml",
              lastSubmitted: "2026-08-01T10:00:00Z",
              lastDownloaded: "2026-08-27T02:00:00Z",
              isPending: false,
              isSitemapsIndex: true,
              type: "sitemapIndex",
              warnings: "2",
              errors: "0",
              contents: [{ type: "web", submitted: "412", indexed: "377" }],
            },
          ],
        }),
    });

    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("1 sitemap submitted for");
    expect(result.text).toContain("https://example.test/sitemap.xml");
    expect(result.text).toContain("submitted: 2026-08-01T10:00:00Z");
    expect(result.text).toContain("downloaded: 2026-08-27T02:00:00Z");
    expect(result.text).toContain("a sitemap index");
    expect(result.text).toContain("0 errors, 2 warnings");
    expect(result.text).toContain("web: 412 submitted, 377 indexed");
  });

  test("a sitemap Google has never downloaded says so in words", async () => {
    // An absent field reads as a formatting gap rather than as the whole answer to "why is it not
    // indexed".
    recordingSearchConsole({
      answer: () =>
        json({
          sitemap: [
            {
              path: "https://example.test/new.xml",
              lastSubmitted: "2026-08-30T10:00:00Z",
            },
          ],
        }),
    });
    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.text).toContain("downloaded: never");
  });

  test("no sitemaps at all is said rather than returned as nothing", async () => {
    recordingSearchConsole({ answer: () => json({}) });
    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("No sitemaps are submitted");
  });
});

describe("what a deployment is told when something is missing", () => {
  test("no properties configured names the variable and the credential", async () => {
    // The catalogue entry stays admissible and grantable without either, so this sentence, rather than
    // a missing connector, is how a deployment finds out.
    useSearchConsole(null);
    const result = await callTool(CONNECTION, "list_sites", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("SEARCH_CONSOLE_SITES");
    expect(result.text).toContain("search-console");
    expect(result.text).toContain("service-account");
  });

  test("no stored service account is its own sentence, with its own fix", async () => {
    // A different job at a different screen. Telling an administrator to set a variable they can see
    // is already set is how a correct instruction gets read as a broken deployment.
    const { calls } = recordingSearchConsole({ credential: async () => null });
    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("holds no Search Console service account");
    expect(result.text).toContain("kind `mcp`");
    expect(result.text).toContain("provider `search-console`");
    expect(result.text).toContain("key id `service-account`");
    expect(result.text).not.toContain("SEARCH_CONSOLE_SITES");
    expect(calls).toEqual([]);
  });

  test("a revoked credential stops the tools within a call rather than after a restart", async () => {
    recordingSearchConsole({
      credential: async () => {
        throw new Error("Credential is revoked");
      },
    });
    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Credential is revoked");
  });
});

describe("what a failure says", () => {
  test("Google's own sentence survives, with the status and without the body", async () => {
    /*
     * The message is the most useful thing available, since a 403 names the property or the API that
     * is not enabled. The surrounding JSON is not: it is the vendor deciding how much of a model's
     * context to spend, and it can carry request echoes.
     */
    recordingSearchConsole({
      answer: () =>
        json(
          {
            error: {
              message:
                "Search Console API has not been used in project 1234 before or it is disabled.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          },
          403,
        ),
    });

    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("(403)");
    expect(result.text).toContain("has not been used in project 1234");
    expect(result.text).not.toContain("SERVICE_DISABLED");
  });

  test("a refusal that is not JSON is still reported by status", async () => {
    recordingSearchConsole({
      answer: () =>
        new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    });
    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("(502)");
    expect(result.text).not.toContain("<html>");
  });

  test("a token that could not be minted comes back as a sentence, not a throw", async () => {
    recordingSearchConsole({
      mintToken: async () => {
        throw new Error("invalid_grant: Invalid JWT Signature.");
      },
    });
    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid_grant");
  });
});

describe("the key and the token never reach an answer", () => {
  test("a failure that quoted the private key is scrubbed, in every spelling", async () => {
    /*
     * Belt and braces over a rule already kept. What this covers is the sentence somebody ELSE wrote:
     * a token endpoint that quotes the assertion back, or an HTTP client that puts request context
     * into the error it raises. That text goes into an audit row and in front of a model.
     */
    recordingSearchConsole({
      mintToken: async () => {
        throw new Error(
          `signing failed for key ${PRIVATE_KEY} and for the stored form ${PRIVATE_KEY.replaceAll("\n", "\\n")}`,
        );
      },
    });

    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });

    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain("MIIEvQIBADAN");
    expect(result.text).not.toContain("BEGIN PRIVATE KEY-----\\nMIIE");
  });

  test("a vendor sentence carrying the bearer token is scrubbed on the success path too", async () => {
    // The refusal below is returned rather than thrown, so it never reaches the failure handler. One
    // scrub over every answer is the only version of this rule that does not depend on remembering it
    // at each call site.
    recordingSearchConsole({
      answer: (recorded) =>
        json(
          {
            error: {
              message: `Request had Authorization: ${recorded.authorization}`,
            },
          },
          401,
        ),
    });

    const result = await callTool(CONNECTION, "list_sitemaps", {
      site: DOMAIN_PROPERTY,
    });

    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain(TOKEN);
  });

  test("the base64 body of a key is redacted even without its PEM wrapper", () => {
    const body = PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, "").replaceAll(
      "\n",
      "",
    );
    expect(redacted(`leaked ${body}`, [PRIVATE_KEY])).toBe("leaked [redacted]");
  });

  test("a short string is left alone, so an ordinary message is not shredded", () => {
    expect(redacted("nothing to see here", ["abc"])).toBe(
      "nothing to see here",
    );
    expect(redacted("nothing to see here", [null, undefined])).toBe(
      "nothing to see here",
    );
  });
});

describe("the access token", () => {
  test("is minted once and reused across calls", async () => {
    // A token is good for an hour and minting one is an RS256 signature plus a round trip. Minting per
    // call would put a second network hop in front of every question a Bot asks.
    const { minted, unlocked } = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });

    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    await callTool(CONNECTION, "list_sitemaps", { site: URL_PROPERTY });

    expect(minted).toHaveLength(1);
    // The credential itself is still read on every call, which is what makes a rotation take effect on
    // the next call and a revocation stop the tools within one.
    expect(unlocked).toHaveLength(3);
  });

  test("is minted again when the credential's id changes, so a rotation is obeyed", async () => {
    /*
     * The whole reason the cache is keyed by the vault row's id rather than kept as one token. A
     * rotated credential is a new row with a new id, so the cached entry no longer matches and the
     * next call mints from the key that is actually stored.
     */
    let id = "cred_first";
    let secret = SERVICE_ACCOUNT;
    const { minted } = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
      credential: async () => ({ id, serviceAccount: secret }),
    });

    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    expect(minted).toHaveLength(1);

    id = "cred_rotated";
    secret = SERVICE_ACCOUNT.replace("example-project", "rotated-project");
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });

    expect(minted).toHaveLength(2);
    expect(minted[1]).toContain("rotated-project");
  });

  test("is minted again once it is close to expiring", async () => {
    // Subtracted rather than compared exactly: a token that expires while a request is in flight is a
    // 401 in the middle of somebody's turn, and this process's clock is not the one Google checks.
    const { minted } = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
      mintToken: async () => ({ token: TOKEN, expiresAt: Date.now() + 30_000 }),
    });

    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });

    expect(minted).toHaveLength(2);
  });

  test("is not carried across a reinstall, so a new configuration mints its own", async () => {
    const first = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    expect(first.minted).toHaveLength(1);

    const second = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    expect(second.minted).toHaveLength(1);
  });

  test("is sent as a bearer token and nothing else is", async () => {
    const { calls } = recordingSearchConsole({
      answer: () => json({ sitemap: [] }),
    });
    await callTool(CONNECTION, "list_sitemaps", { site: DOMAIN_PROPERTY });
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("asks for the read-only scope, because every tool here is a read", () => {
    // The writing scope would let a token submit and delete sitemaps, which is a thing nobody asked
    // this connector to be able to do, so it is not requested rather than requested and declined.
    expect(READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
  });
});

describe("an unknown tool", () => {
  test("is refused with the reason it can happen, rather than guessed at", async () => {
    recordingSearchConsole();
    const result = await callTool(CONNECTION, "submit_sitemap", {
      site: DOMAIN_PROPERTY,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("is not a tool Search Console implements");
    expect(result.text).toContain("refresh it on the Plugins page");
  });
});
