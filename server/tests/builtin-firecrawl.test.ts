import { afterEach, describe, expect, test } from "bun:test";
import type { FirecrawlConfig } from "../src/config";
import { redacted } from "../src/firecrawl/client";
import {
  callTool,
  firecrawlCredential,
  harvest,
  listNeedsCredential,
  listTools,
  pageText,
  rankContactPages,
  selectUrl,
  useFirecrawl,
} from "../src/plugins/builtin-firecrawl";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";

/**
 * The builtin Firecrawl transport, asserted without an instance.
 *
 * What is under test is the boundary, not Firecrawl: which address a call is allowed to be about,
 * what URL and body actually go out and with what attached, what a model is told when something is
 * missing, and that the key never comes back in an answer. A recording stub is installed through
 * {@link useFirecrawl}, which is the seam this module has because `transportFor` resolves a kind to a
 * MODULE.
 */

const CONNECTION = {
  url: "builtin://firecrawl/",
  actorId: "user_asker",
  botId: "bot_helper",
};

const CA =
  "-----BEGIN CERTIFICATE-----\nMIIDJDCCAgygAwIBAgIU\n-----END CERTIFICATE-----\n";

const CONFIG: FirecrawlConfig = {
  baseUrl: "https://firecrawl.example.test:3002",
  ca: CA,
};

const API_KEY = "fc-0123456789abcdef0123456789abcdef";

type Recorded = {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    tls?: { ca: string };
  };
};

/** A queued reply: a status and body, or a bare body answered with 200. */
type Answer = { status?: number; body: unknown } | Record<string, unknown>;

function asAnswer(next: Answer): { status: number; body: unknown } {
  if ("body" in next && ("status" in next || Object.keys(next).length === 1)) {
    const reply = next as { status?: number; body: unknown };
    return { status: reply.status ?? 200, body: reply.body };
  }
  return { status: 200, body: next };
}

/**
 * Install a stub that answers each request from a queue, or from a function of the URL, and records
 * what went out.
 */
function install(
  answers: Answer[] | ((url: string, body: unknown) => Answer),
  options: { credential?: string | null; config?: FirecrawlConfig } = {},
): Recorded[] {
  const recorded: Recorded[] = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  useFirecrawl({
    config: options.config ?? CONFIG,
    credential: async () =>
      options.credential === undefined ? API_KEY : options.credential,
    fetch: async (url, init) => {
      recorded.push({ url, init: init ?? {} });
      const parsed = init?.body ? JSON.parse(init.body) : {};
      const next = queue
        ? queue.shift()
        : (answers as (url: string, body: unknown) => Answer)(url, parsed);
      if (!next) throw new Error(`no answer queued for ${url}`);
      const answer = asAnswer(next);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return recorded;
}

const page = (
  markdown: string,
  links: string[] = [],
  metadata: Record<string, unknown> = {},
) => ({
  success: true,
  data: { markdown, links, metadata },
});

afterEach(() => {
  useFirecrawl(null);
});

describe("what the connector offers", () => {
  test("lists three read tools without a configured instance, so grants survive an unset variable", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "scrape",
      "map_site",
      "find_contacts",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ required: ["url"] });
    }
    expect(listNeedsCredential).toBe(false);
  });

  test("names the one credential it reads from the vault", () => {
    expect(firecrawlCredential()).toEqual({
      kind: "mcp",
      provider: "firecrawl",
      keyId: "api-key",
    });
  });
});

describe("which address a call may be about", () => {
  test("requires a url", () => {
    expect(selectUrl({}).error).toContain("`url` is required");
    expect(selectUrl({ url: "   " }).error).toContain("`url` is required");
  });

  test("refuses anything that is not a public web address", () => {
    for (const url of [
      "not a url",
      "ftp://example.test/file",
      "http://localhost:3001/health",
      "http://127.0.0.1/",
      "http://10.0.0.5/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
    ]) {
      const verdict = selectUrl({ url });
      expect(verdict.url).toBeUndefined();
      expect(verdict.error).toBeDefined();
    }
  });

  test("admits a public address and returns it normalised", () => {
    expect(selectUrl({ url: "https://Example.Test/pricing" }).url).toBe(
      "https://example.test/pricing",
    );
  });

  test("a refused address never reaches the vault", async () => {
    let read = 0;
    useFirecrawl({
      config: CONFIG,
      credential: async () => {
        read += 1;
        return API_KEY;
      },
      fetch: async () => {
        throw new Error("nothing should be fetched");
      },
    });
    const result = await callTool(CONNECTION, "scrape", {
      url: "http://10.0.0.5/",
    });
    expect(result.isError).toBe(true);
    expect(read).toBe(0);
  });
});

describe("what a call answers when the deployment is not ready", () => {
  test("names the variable and the vault key when nothing is installed", async () => {
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("FIRECRAWL_BASE_URL");
    expect(result.text).toContain("provider `firecrawl`");
  });

  test("names the vault key when the instance is configured and the key is not", async () => {
    install([], { credential: null });
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no Firecrawl API key");
  });

  test("refuses a tool it does not have", async () => {
    install([]);
    const result = await callTool(CONNECTION, "crawl", {
      url: "https://example.test/",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no tool called crawl");
  });
});

describe("scrape", () => {
  test("posts to the instance with the key in the header and the CA on the request", async () => {
    const recorded = install([
      page("# Hello\n\nA page.", ["https://example.test/about"], {
        title: "Example",
        description: "An example site",
        sourceURL: "https://example.test/",
        statusCode: 200,
      }),
    ]);
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(result.isError).toBe(false);
    expect(recorded).toHaveLength(1);
    const [request] = recorded;
    expect(request?.url).toBe("https://firecrawl.example.test:3002/v2/scrape");
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request?.init.tls).toEqual({ ca: CA });
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      url: "https://example.test/",
      formats: ["markdown", "links"],
      onlyMainContent: true,
    });
    expect(result.text).toContain("# Example");
    expect(result.text).toContain("URL: https://example.test/");
    expect(result.text).toContain("Description: An example site");
    expect(result.text).toContain("A page.");
    expect(result.text).toContain("- https://example.test/about");
  });

  test("attaches no CA when none is configured", async () => {
    const recorded = install([page("x")], {
      config: { baseUrl: "https://firecrawl.example.test" },
    });
    await callTool(CONNECTION, "scrape", { url: "https://example.test/" });
    expect(recorded[0]?.init.tls).toBeUndefined();
  });

  test("passes only_main_content through and cuts the page at max_chars, saying so", async () => {
    const recorded = install([page("y".repeat(5_000))]);
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
      only_main_content: false,
      max_chars: 300,
    });
    expect(JSON.parse(recorded[0]?.init.body ?? "{}").onlyMainContent).toBe(
      false,
    );
    expect(result.text).toContain("[cut at 300 of 5000 characters");
    expect(result.text.length).toBeLessThan(1_000);
  });

  test("refuses a max_chars that is not a whole number", async () => {
    install([page("x")]);
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
      max_chars: 12.5,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("`max_chars`");
  });

  test("caps the whole answer at the transport's visible limit", async () => {
    install([page("z".repeat(MAX_RESULT_CHARS * 2))]);
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
      max_chars: MAX_RESULT_CHARS * 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 100);
  });

  test("turns the instance's refusals into sentences that name the fix", async () => {
    install([{ status: 401, body: { success: false, error: "Unauthorized" } }]);
    const unauthorized = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.text).toContain("refused the deployment's API key");

    install([{ status: 429, body: { success: false, error: "Slow down" } }]);
    const limited = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(limited.text).toContain("rate limiting");
    expect(limited.text).toContain("Slow down");

    install([
      { status: 500, body: { success: false, error: "Rendering failed" } },
    ]);
    const failed = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(failed.text).toContain("(500): Rendering failed");
  });

  test("never lets the key into an answer, whichever way the instance put it there", async () => {
    install([
      {
        status: 500,
        body: { success: false, error: `bad token ${API_KEY} rejected` },
      },
    ]);
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(result.text).not.toContain(API_KEY);
    expect(result.text).toContain("[redacted]");

    install([page(`Our key is ${API_KEY}, do not share.`)]);
    const echoed = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(echoed.text).not.toContain(API_KEY);
  });

  test("says when a page rendered with nothing to read", async () => {
    install([page("")]);
    const result = await callTool(CONNECTION, "scrape", {
      url: "https://example.test/",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("no readable text");
  });
});

describe("map_site", () => {
  test("posts the search and a bounded limit, and reads both answer shapes", async () => {
    const recorded = install([
      {
        body: {
          success: true,
          links: [
            { url: "https://example.test/contact", title: "Contact us" },
            "https://example.test/about",
          ],
        },
      },
    ]);
    const result = await callTool(CONNECTION, "map_site", {
      url: "https://example.test/",
      search: "contact",
      limit: "500",
    });
    expect(recorded[0]?.url).toBe("https://firecrawl.example.test:3002/v2/map");
    expect(JSON.parse(recorded[0]?.init.body ?? "{}")).toEqual({
      url: "https://example.test/",
      search: "contact",
      limit: 200,
    });
    expect(result.text).toContain("2 addresses on https://example.test/");
    expect(result.text).toContain(
      "- https://example.test/contact (Contact us)",
    );
    expect(result.text).toContain("- https://example.test/about");
  });

  test("says when the map is empty rather than answering with nothing", async () => {
    install([{ body: { success: true, links: [] } }]);
    const result = await callTool(CONNECTION, "map_site", {
      url: "https://example.test/",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("found no addresses");
  });
});

describe("find_contacts", () => {
  const HOME = page(
    "# Acme\n\nThe tool for makers. Built by Jane Doe.\n",
    [
      "https://acme.test/about",
      "https://acme.test/pricing",
      "https://acme.test/blog",
      "https://x.com/janedoe",
      "https://twitter.com/intent/tweet?text=hi",
      "https://www.linkedin.com/in/jane-doe",
      "https://github.com/acme-tools",
      "mailto:hello@acme.test?subject=Hi",
    ],
    { title: "Acme", sourceURL: "https://acme.test/" },
  );
  const ABOUT = page(
    "# About\n\nWrite to founders@acme.test or press@acme.test. Logo: hero@2x.png",
    ["https://acme.test/contact"],
  );
  const CONTACT = page("# Contact\n\n[Send a message](#form)\n", []);
  const PRICING = page("# Pricing\n\n$9 a month.", []);

  test("reads the home page, then the contact-looking pages, and returns what it found as JSON", async () => {
    const recorded = install((url, body) => {
      const target = (body as { url?: string }).url ?? "";
      if (url.endsWith("/v2/map"))
        return { body: { success: true, links: [] } };
      if (target === "https://acme.test/") return { body: HOME };
      if (target === "https://acme.test/about") return { body: ABOUT };
      if (target === "https://acme.test/contact") return { body: CONTACT };
      if (target === "https://acme.test/pricing") return { body: PRICING };
      return { status: 500, body: { success: false, error: "unexpected" } };
    });
    const result = await callTool(CONNECTION, "find_contacts", {
      url: "https://acme.test/",
      max_pages: 4,
    });
    expect(result.isError).toBe(false);
    const found = JSON.parse(result.text);
    expect(found.emails).toEqual([
      "hello@acme.test",
      "founders@acme.test",
      "press@acme.test",
    ]);
    expect(found.x).toEqual(["https://x.com/janedoe"]);
    expect(found.linkedin).toEqual(["https://www.linkedin.com/in/jane-doe"]);
    expect(found.github).toEqual(["https://github.com/acme-tools"]);
    expect(found.pricing_page).toBe("https://acme.test/pricing");
    expect(found.contact_forms).toEqual(["https://acme.test/contact"]);
    expect(found.maker_hints).toEqual([
      "The tool for makers. Built by Jane Doe.",
    ]);
    // Home first. The home page linked About and Pricing; About linked Contact, which outranks
    // Pricing, so it is read next even though the home page never mentioned it.
    expect(found.pages_read).toEqual([
      "https://acme.test/",
      "https://acme.test/about",
      "https://acme.test/contact",
      "https://acme.test/pricing",
    ]);
    // The home page linked two contact-looking pages, so the map was not needed.
    expect(recorded.some((request) => request.url.endsWith("/v2/map"))).toBe(
      false,
    );
  });

  test("falls back to a site map when the home page links no contact page, and survives a broken page", async () => {
    const recorded = install((url, body) => {
      const target = (body as { url?: string }).url ?? "";
      if (url.endsWith("/v2/map")) {
        return {
          body: {
            success: true,
            links: [
              { url: "https://acme.test/contact" },
              { url: "https://acme.test/team" },
              { url: "https://elsewhere.test/contact" },
            ],
          },
        };
      }
      if (target === "https://acme.test/") {
        return { body: page("# Acme\n\nJust a landing page.", []) };
      }
      if (target === "https://acme.test/contact") {
        return { status: 500, body: { success: false, error: "boom" } };
      }
      if (target === "https://acme.test/team") {
        return { body: page("Team: reach us at team@acme.test", []) };
      }
      return { status: 500, body: { success: false, error: "unexpected" } };
    });
    const result = await callTool(CONNECTION, "find_contacts", {
      url: "https://acme.test/",
    });
    const found = JSON.parse(result.text);
    const map = recorded.find((request) => request.url.endsWith("/v2/map"));
    expect(JSON.parse(map?.init.body ?? "{}")).toMatchObject({
      url: "https://acme.test",
      search: "contact about team pricing",
    });
    expect(found.emails).toEqual(["team@acme.test"]);
    // The broken contact page is absent from pages_read rather than failing the call.
    expect(found.pages_read).toEqual([
      "https://acme.test/",
      "https://acme.test/team",
    ]);
  });

  test("answers empty fields, not an error, for a site that publishes no contact", async () => {
    install((url) => {
      if (url.endsWith("/v2/map"))
        return { body: { success: true, links: [] } };
      return { body: page("# Nothing here", []) };
    });
    const result = await callTool(CONNECTION, "find_contacts", {
      url: "https://quiet.test/",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      site: "https://quiet.test/",
      emails: [],
      x: [],
      linkedin: [],
      github: [],
      contact_forms: [],
      pricing_page: null,
      maker_hints: [],
      pages_read: ["https://quiet.test/"],
    });
  });
});

describe("the pure helpers", () => {
  test("rankContactPages keeps the same site only and orders contact before pricing", () => {
    const site = new URL("https://acme.test/");
    expect(
      rankContactPages(
        [
          "https://acme.test/pricing",
          "https://www.acme.test/about#team",
          "/contact",
          "https://other.test/contact",
          "mailto:x@acme.test",
          "https://acme.test/blog/post",
          "https://acme.test/about",
        ],
        site,
      ),
    ).toEqual([
      "https://acme.test/contact",
      "https://acme.test/about",
      "https://acme.test/pricing",
    ]);
  });

  test("harvest ignores asset names that look like addresses and repeated finds", () => {
    const found = {
      site: "https://acme.test/",
      emails: [],
      x: [],
      linkedin: [],
      github: [],
      contact_forms: [],
      pricing_page: null,
      maker_hints: [],
      pages_read: [],
    };
    harvest(
      found,
      {
        markdown: "hi@acme.test hi@acme.test logo@2x.png icon@3x.jpg",
        links: [
          "https://x.com/acme",
          "https://x.com/acme",
          "https://github.com/orgs/acme",
        ],
      },
      "https://acme.test/",
    );
    expect(found.emails).toEqual(["hi@acme.test"]);
    expect(found.x).toEqual(["https://x.com/acme"]);
    expect(found.github).toEqual([]);
  });

  test("pageText falls back to the address when a page has no title", () => {
    const text = pageText({ markdown: "body" }, "https://acme.test/x", 100);
    expect(
      text.startsWith("# https://acme.test/x\nURL: https://acme.test/x"),
    ).toBe(true);
  });

  test("redacted scrubs the key and leaves short strings alone", () => {
    expect(redacted(`key ${API_KEY} here`, [API_KEY, "short", null])).toBe(
      "key [redacted] here",
    );
  });
});
