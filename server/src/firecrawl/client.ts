/**
 * The only place in this deployment that talks to Firecrawl.
 *
 * One door, for the reason `search-console/client.ts` and `mailbox/client.ts` are each one door:
 * every call out carries the deployment's API key and brings back text a model will read, so both
 * directions want a single place to be careful in. A second client somewhere else would be a second
 * place to forget the deadline, the private CA, or the rule that the key never appears in anything
 * anybody reads.
 *
 * WHAT THIS MODULE IS NOT. It decides nothing about which address may be scraped or what a model
 * should be told; `plugins/builtin-firecrawl.ts` holds the tools, the address checks, the contact
 * extraction and the sentences. This speaks HTTP and hands back plain values.
 *
 * THE INSTANCE IS THE DEPLOYMENT'S OWN. Firecrawl is open source and this deployment runs its own
 * copy, on an address that is configuration rather than a constant, usually behind a certificate
 * signed by a private CA. That CA is passed to fetch per request, the way `computer/sandbox.ts` hands
 * a cluster's CA to the API server: trust is scoped to these calls and nothing else in the process
 * stops verifying anything. The alternative some reach for, switching verification off, would leave
 * the key in every one of these requests open to whatever can answer on that address.
 */

/**
 * How long Firecrawl gets before we give up on it.
 *
 * Longer than the thirty seconds the other clients allow, on purpose: a scrape renders the page in a
 * browser first, and a page that loads its content with JavaScript, which is what most launch
 * directories do, takes a while to settle. nicklaunches.com's own badge check allows forty-five
 * seconds for the same instance; a minute leaves room for a slow directory without letting a dead
 * one hold a turn for longer than a person would wait.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

export class FirecrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlError";
  }
}

/**
 * What one request needs beyond its body: where the instance is, what unlocks it, and what signs
 * its certificate. Resolved per call by the builtin, so a rotated key is obeyed by the next request.
 */
export type FirecrawlAccess = {
  baseUrl: string;
  apiKey: string;
  /** The PEM of the CA that signed the instance's certificate, when it is not a public one. */
  ca?: string;
};

/**
 * `fetch`, narrowed to what this module sends, and widened by the one option Bun adds.
 *
 * `tls` is Bun's per-request trust, not a standard `RequestInit` field, which is why it is spelled
 * here rather than assumed: a stub in a test can assert it was passed, and a reader can see that the
 * CA rides with the request rather than being installed process-wide.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    tls?: { ca: string };
  },
) => Promise<Response>;

/** What Firecrawl says about a page it fetched, in the parts this deployment reads. */
export type ScrapedPage = {
  markdown?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
    error?: string;
    [key: string]: unknown;
  };
};

/** One address a site map found. Firecrawl v2 names each with a title when it has one. */
export type MappedLink = {
  url: string;
  title?: string;
  description?: string;
};

export type ScrapeOptions = {
  /** Strip navigation, footers and the like. What a model reads is the article, not the chrome. */
  onlyMainContent?: boolean;
};

export type MapOptions = {
  /** Words the addresses should be about. Firecrawl ranks the map by them. */
  search?: string;
  /** How many addresses to return at most. */
  limit?: number;
};

/**
 * One page, rendered, as markdown plus the links it carries.
 *
 * Both formats are asked for in one request rather than two, because they come from the same render
 * and the links are what turn a directory page into the next thing to read.
 */
export async function scrape(
  http: FetchLike,
  access: FirecrawlAccess,
  url: string,
  options: ScrapeOptions = {},
): Promise<ScrapedPage> {
  const body = await post(http, access, "/v2/scrape", {
    url,
    formats: ["markdown", "links"],
    onlyMainContent: options.onlyMainContent ?? true,
  });
  const page = (body as { data?: unknown }).data;
  if (!page || typeof page !== "object") {
    throw new FirecrawlError(
      "Firecrawl answered without a page. The address may not have loaded.",
    );
  }
  const data = page as ScrapedPage;
  if (data.metadata?.error && !data.markdown) {
    throw new FirecrawlError(
      `Firecrawl could not load that page: ${String(data.metadata.error).slice(0, 200)}`,
    );
  }
  return {
    ...(typeof data.markdown === "string" ? { markdown: data.markdown } : {}),
    links: Array.isArray(data.links)
      ? data.links.filter((link): link is string => typeof link === "string")
      : [],
    ...(data.metadata && typeof data.metadata === "object"
      ? { metadata: data.metadata }
      : {}),
  };
}

/**
 * The addresses a site has, ranked by what they are about when a search term is given.
 *
 * Firecrawl v2 answers with objects that carry a title; v1, and some builds in between, answered
 * with bare strings. Both are read, because which one a self-hosted instance speaks depends on the
 * image somebody pulled, and an operator upgrading it should not lose the contact finder.
 */
export async function mapSite(
  http: FetchLike,
  access: FirecrawlAccess,
  url: string,
  options: MapOptions = {},
): Promise<MappedLink[]> {
  const body = await post(http, access, "/v2/map", {
    url,
    ...(options.search ? { search: options.search } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
  const raw = (body as { links?: unknown }).links;
  if (!Array.isArray(raw)) return [];
  const links: MappedLink[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      links.push({ url: item });
    } else if (item && typeof item === "object") {
      const entry = item as Partial<MappedLink>;
      if (typeof entry.url !== "string") continue;
      links.push({
        url: entry.url,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        ...(typeof entry.description === "string"
          ? { description: entry.description }
          : {}),
      });
    }
  }
  return links;
}

/** One web search result, in the parts a model needs to decide whether to open it. */
export type SearchHit = {
  url: string;
  title?: string;
  description?: string;
};

export type SearchOptions = {
  /** How many results to return at most. */
  limit?: number;
};

/**
 * A web search through the instance's own search backend.
 *
 * A self-hosted Firecrawl searches through whatever engine it was given (SearXNG, usually), so the
 * results are that engine's. Only the `web` results are read; an instance that also answers with
 * news or images is answering a question nobody here asked.
 */
export async function searchWeb(
  http: FetchLike,
  access: FirecrawlAccess,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const body = await post(http, access, "/v2/search", {
    query,
    ...(options.limit ? { limit: options.limit } : {}),
  });
  const data = (body as { data?: unknown }).data;
  const raw =
    data && typeof data === "object" && "web" in data
      ? (data as { web?: unknown }).web
      : data;
  if (!Array.isArray(raw)) return [];
  const hits: SearchHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<SearchHit>;
    if (typeof entry.url !== "string") continue;
    hits.push({
      url: entry.url,
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    });
  }
  return hits;
}

/**
 * One POST to the instance, with the deadline, the key and the CA attached.
 *
 * Failures are thrown as {@link FirecrawlError} with a sentence that names the fix where the status
 * does: a 401 is the key, a 402 is a plan the self-hosted instance does not have, a 429 is Firecrawl's
 * own rate limit, and a timeout is the page rather than the instance. The response body is read for
 * Firecrawl's own `error` field and nothing else, because the body of a failed scrape is not
 * something a model should be handed in place of an answer.
 */
async function post(
  http: FetchLike,
  access: FirecrawlAccess,
  path: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const base = access.baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await http(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.apiKey}`,
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(access.ca ? { tls: { ca: access.ca } } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new FirecrawlError(
        "Firecrawl did not answer in time. The page may be slow to render; try again, or a more specific address.",
      );
    }
    throw new FirecrawlError(
      `Firecrawl could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = await response.text().catch(() => "");
  let parsed: { success?: boolean; error?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw) as { success?: boolean; error?: unknown };
  } catch {
    parsed = null;
  }

  if (!response.ok || parsed?.success === false) {
    const detail =
      typeof parsed?.error === "string" ? parsed.error.slice(0, 300) : "";
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new FirecrawlError(
        "Firecrawl refused the deployment's API key. An administrator has to store the current key as the firecrawl credential.",
      );
    }
    if (status === 429) {
      throw new FirecrawlError(
        `Firecrawl is rate limiting this deployment${detail ? `: ${detail}` : "."}`,
      );
    }
    throw new FirecrawlError(
      detail
        ? `Firecrawl refused this request (${status}): ${detail}`
        : `Firecrawl refused this request (${status}).`,
    );
  }

  if (parsed === null) {
    throw new FirecrawlError(
      `Firecrawl answered ${response.status} with something that is not JSON.`,
    );
  }
  return parsed;
}

/**
 * A sentence with the key taken out of it.
 *
 * The one rule every answer and every failure passes through. An HTTP client that put the request's
 * `Authorization` header into the error it raised would otherwise hand the key to whoever reads the
 * transcript; scrubbing here, once, is the version of the rule that does not depend on remembering it
 * at each call site.
 */
export function redacted(
  message: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let scrubbed = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return scrubbed;
}
