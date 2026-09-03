import { checkNavigationTarget } from "../computer/target";
import type { FirecrawlConfig } from "../config";
import {
  type FetchLike,
  FirecrawlError,
  type MappedLink,
  mapSite,
  redacted,
  type ScrapedPage,
  scrape,
} from "../firecrawl/client";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin transport for Firecrawl: a Bot reading the public web through this deployment's own
 * scraping instance, from a turn that has no browser.
 *
 * WHY IT EXISTS WHEN A BOT HAS A COMPUTER. A Bot in a channel can open any page on its own Chromium.
 * A routine cannot: a scheduled run is headless and registers no browser tools, so "every morning,
 * read what launched today" had no way to read anything. This is that way. It is also the cheaper
 * one when the question is "what does this page say" rather than "click this": one call returns the
 * page as markdown with its links, instead of a navigate, a snapshot and a read.
 *
 * WHERE IT SITS BETWEEN THE OTHER BUILTINS. It is the Search Console shape: one key, held by the
 * deployment, used for every Bot granted the tools, and no person consents to it. The authorization
 * is the GRANT, decided per tool on the Plugins page, and nothing here reads `connection.actorId` as
 * permission.
 *
 * EVERY TOOL IS A READ of somebody else's public page, and that is the one thing the address check
 * below is for. The instance fetches whatever it is told to, from wherever it runs, so an address on
 * a private network or at a cloud metadata endpoint is refused HERE, before the key is read, by the
 * same rule the Bot's own browser applies to a navigation. What the instance can reach on its own
 * network is not a thing a model gets to name.
 *
 * THE KEY IS NEVER IN THE ENVIRONMENT and never in an answer. The address of the instance and the CA
 * that signs its certificate come from `config.ts`; the key comes from the encrypted vault, resolved
 * through {@link FirecrawlAccess.credential} at the moment a call needs it and thrown away after.
 * {@link redacted} is the last line: a failure sentence that carried it is scrubbed before anybody
 * reads it.
 *
 * It implements the same interface as every other transport, as module-level exports, because that is
 * the shape {@link ./transport} resolves: a `TransportKind` maps to a MODULE, which is why the
 * configuration and the vault arrive through {@link useFirecrawl} rather than a constructor.
 */

/**
 * What the tools act through: where the instance is, and how to unlock it.
 *
 * `credential` is a function rather than a string for the reason the other builtins give: a secret
 * read once at boot is stale the moment an administrator rotates it. Read per call, a rotation takes
 * effect on the next call and a revocation refuses it.
 */
export type FirecrawlAccess = {
  config: FirecrawlConfig;
  /** The stored API key, or null when this deployment holds none. */
  credential: () => Promise<string | null>;
  /**
   * How a request is actually made. Defaults to the global `fetch`.
   *
   * Injected for the properties that are otherwise untestable and most worth being sure about: which
   * URL a call went out to, that the key rode in the header and not the address, and that the CA was
   * attached to the request rather than installed process-wide.
   */
  fetch?: FetchLike;
};

/**
 * Which credential in the vault is the API key.
 *
 * A contract with two other parties: the administrator who types these three values at
 * `/admin/credentials`, and `docs/firecrawl.md`, which tells them to. One credential rather than one
 * per anything: the instance has one key and every Bot granted the tools spends it.
 */
export function firecrawlCredential(): {
  kind: "mcp";
  provider: "firecrawl";
  keyId: string;
} {
  return { kind: "mcp", provider: "firecrawl", keyId: "api-key" };
}

let installed: FirecrawlAccess | null = null;

/**
 * Hand this module its configuration and its vault, once, from the place that has both.
 *
 * `null` is a supported argument: the suite is one process, so a test that installs a stub has to be
 * able to take it back out again, and a deployment with no instance configured installs nothing.
 */
export function useFirecrawl(access: FirecrawlAccess | null): void {
  installed = access;
}

/**
 * What a call answers when this deployment has no instance configured.
 *
 * Names both halves, including the one that is not an environment variable, because the half a reader
 * is most likely to be missing is the half that is not in `.env`. The catalogue entry stays admissible
 * and grantable without either, so this sentence, rather than a missing connector, is how a
 * deployment finds out.
 */
const NOT_CONFIGURED =
  "Firecrawl is not configured. Set FIRECRAWL_BASE_URL to this deployment's Firecrawl instance (and FIRECRAWL_CA_FILE to the certificate authority that signs it, when that is not a public one), and store the instance's API key as the firecrawl credential (kind `mcp`, provider `firecrawl`, key id `api-key`).";

/** What a call answers when the instance is configured and the vault holds no key. */
const NO_CREDENTIAL =
  "This deployment holds no Firecrawl API key. An administrator has to store it as the firecrawl credential (kind `mcp`, provider `firecrawl`, key id `api-key`) before anything can be read.";

/** How much of a page one `scrape` answer carries when the caller did not say. */
const DEFAULT_PAGE_CHARS = 12_000;

/** How many links a `scrape` answer lists. Past this the list is noise, and the map tool exists. */
const MAX_LISTED_LINKS = 80;

/** Bounds on how many addresses one `map_site` call returns. */
const MAP_LIMIT = { fallback: 50, max: 200 } as const;

/** Bounds on how many pages `find_contacts` reads for one site. */
const CONTACT_PAGES = { fallback: 4, max: 8 } as const;

const URL_ARGUMENT = Object.freeze({
  type: "string",
  description:
    "The web address to read, with its scheme: https://example.com/pricing. Public addresses only; anything on a private network is refused.",
} as const);

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "scrape",
    description: [
      "Read one web page through the deployment's Firecrawl instance, rendered the way a browser",
      "would render it, and get it back as markdown together with the links on it. Use it to read a",
      "launch directory's listing page, a product's site, or any page whose text you need, when you",
      "have no browser of your own or when reading is all you need.",
      "",
      "Every call renders the page fresh and takes a few seconds, so read the page you need rather",
      "than every page you could. The links come back separately from the text, so a directory page",
      "gives you both what launched and where each entry leads.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        url: URL_ARGUMENT,
        only_main_content: {
          type: "boolean",
          description:
            "Strip navigation, footers and sidebars and keep the page's own content. Default true. Set false when the part you need is in the chrome, such as a footer's contact line.",
        },
        max_chars: {
          type: "integer",
          description: `How much of the page text to return, at most. Default ${DEFAULT_PAGE_CHARS}; the answer says when it was cut.`,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "map_site",
    description: [
      "List the addresses a site has, optionally ranked by what they are about. Use it to find a",
      "site's about, team, contact or pricing page without reading the whole site: map it with a",
      "search term, then scrape the one or two addresses that match.",
      "",
      "This reads the site's link structure rather than every page, so it is fast and cheap, and it",
      "is the right first call on an unfamiliar site.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        url: URL_ARGUMENT,
        search: {
          type: "string",
          description:
            "Words the addresses should be about, such as `contact` or `pricing`. Addresses are ranked by how well they match.",
        },
        limit: {
          type: "integer",
          description: `How many addresses to return at most. Default ${MAP_LIMIT.fallback}, at most ${MAP_LIMIT.max}.`,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "find_contacts",
    description: [
      "Find how to reach the people behind a product's site: email addresses, X/Twitter, LinkedIn",
      "and GitHub profiles, a contact form, and the pricing page if there is one. One call reads the",
      "home page, finds the about, team, contact and pricing pages, reads a few of them, and returns",
      "what it found as JSON, so you do not have to scrape each page yourself.",
      "",
      "Use it once per product, on the product's own site rather than on the directory that listed",
      "it. An empty result means the site publishes no contact; say so rather than guessing one.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        url: URL_ARGUMENT,
        max_pages: {
          type: "integer",
          description: `How many pages of the site to read, counting the home page. Default ${CONTACT_PAGES.fallback}, at most ${CONTACT_PAGES.max}.`,
        },
      },
      required: ["url"],
    },
  },
]);

/**
 * The shape every transport's `callTool` receives. Declared locally, like the other builtins do, so a
 * change to the registry's connection type is a type error here rather than a silent widening.
 */
type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

/**
 * The list is static and needs neither a credential nor a configured instance.
 *
 * Listing without a configured deployment is deliberate: an administrator sets a connector up and
 * grants its tools before, or instead of, the deployment ever having the key, and a tool list that
 * emptied itself when a variable was unset would revoke grants by accident.
 */
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Success as a result, with the same visible cap the vendor transports use. */
function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

/** A string argument that was actually given, or nothing. Blank is not a value. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * A whole number argument, or nothing, or a refusal.
 *
 * A string of digits counts, because models produce `"50"` for an integer field often enough that
 * refusing it would be refusing a correct intention over a JSON type.
 */
export function integerArg(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
): { value?: number; error?: string } {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return {};

  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isInteger(value) || value < minimum) {
    return {
      error: `\`${key}\` has to be a whole number, at least ${minimum}.`,
    };
  }
  return { value };
}

/** A boolean argument, reading the two spellings a model produces for one. */
function booleanArg(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = args[key];
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** A count capped rather than refused, and said to have been. */
function bounded(
  asked: number | undefined,
  bounds: { fallback: number; max: number },
): number {
  if (asked === undefined) return bounds.fallback;
  return Math.min(asked, bounds.max);
}

/**
 * The address settled before anything else: a URL, over http(s), on a public host.
 *
 * The same verdict the Bot's browser gives a navigation, because it is the same question: the fetch
 * happens from a machine on this deployment's network, and a model must not be able to name that
 * network's own addresses. Private hosts are never allowed here, even where a deployment allows
 * its browser to reach them, because the instance is not the browser and its network is not known.
 */
export function selectUrl(args: Record<string, unknown>): {
  url?: string;
  error?: string;
} {
  const raw = stringArg(args, "url");
  if (!raw)
    return { error: "`url` is required: the address of the page to read." };
  const verdict = checkNavigationTarget(raw, { allowPrivateHosts: false });
  if (!verdict.allowed) return { error: verdict.reason };
  return { url: verdict.url };
}

/**
 * The transport's entry point, called by `plugins/store.ts` after the grant check and the policy
 * decision. Nothing thrown escapes: every failure comes back as an `isError` result, which is what
 * the vendor transports do and what `plugins/tools.ts` expects.
 */
export async function callTool(
  _connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const access = installed;
  if (!access) return failure(NOT_CONFIGURED);
  if (!TOOLS.some((tool) => tool.name === toolName)) {
    return failure(`Firecrawl has no tool called ${toolName}.`);
  }

  /*
   * THE ADDRESS IS SETTLED BEFORE THE VAULT IS READ. An address this deployment must not fetch is
   * refused without a credential being decrypted or a request being made, so a model that named one
   * costs nothing and learns why.
   */
  const chosen = selectUrl(args);
  if (chosen.error || !chosen.url) {
    return failure(chosen.error ?? "`url` is required.");
  }

  let apiKey: string | null = null;
  try {
    apiKey = await access.credential();
    if (!apiKey) return failure(NO_CREDENTIAL);

    const http = access.fetch ?? (fetch as unknown as FetchLike);
    const instance = {
      baseUrl: access.config.baseUrl,
      apiKey,
      ...(access.config.ca ? { ca: access.config.ca } : {}),
    };
    const result = await runTool(http, instance, chosen.url, toolName, args);
    // Every answer goes through the scrub, not only the failure path below.
    return { ...result, text: redacted(result.text, [apiKey]) };
  } catch (error) {
    const message =
      error instanceof FirecrawlError || error instanceof Error
        ? error.message
        : String(error);
    return failure(redacted(message, [apiKey]).slice(0, 400));
  }
}

/** The work itself, once the address and the key are settled. */
async function runTool(
  http: FetchLike,
  instance: { baseUrl: string; apiKey: string; ca?: string },
  url: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  switch (toolName) {
    case "scrape": {
      const chars = integerArg(args, "max_chars", 200);
      if (chars.error) return failure(chars.error);
      const page = await scrape(http, instance, url, {
        onlyMainContent: booleanArg(args, "only_main_content", true),
      });
      return asResult(pageText(page, url, chars.value ?? DEFAULT_PAGE_CHARS));
    }
    case "map_site": {
      const limit = integerArg(args, "limit", 1);
      if (limit.error) return failure(limit.error);
      const links = await mapSite(http, instance, url, {
        ...(stringArg(args, "search")
          ? { search: stringArg(args, "search") as string }
          : {}),
        limit: bounded(limit.value, MAP_LIMIT),
      });
      return asResult(mapText(links, url));
    }
    case "find_contacts": {
      const pages = integerArg(args, "max_pages", 1);
      if (pages.error) return failure(pages.error);
      const found = await findContacts(
        http,
        instance,
        url,
        bounded(pages.value, CONTACT_PAGES),
      );
      return asResult(JSON.stringify(found, null, 2));
    }
    default:
      return failure(`Firecrawl has no tool called ${toolName}.`);
  }
}

/** A scraped page as the text a model reads: what it is, where it was, and what it says. */
export function pageText(
  page: ScrapedPage,
  url: string,
  maxChars: number,
): string {
  const lines: string[] = [];
  const title = page.metadata?.title?.trim();
  const description = page.metadata?.description?.trim();
  const source = page.metadata?.sourceURL?.trim() || url;
  lines.push(`# ${title || source}`);
  lines.push(`URL: ${source}`);
  if (description) lines.push(`Description: ${description}`);
  if (typeof page.metadata?.statusCode === "number") {
    lines.push(`Status: ${page.metadata.statusCode}`);
  }
  lines.push("");

  const markdown = (page.markdown ?? "").trim();
  if (!markdown) {
    lines.push("(The page rendered with no readable text.)");
  } else if (markdown.length > maxChars) {
    lines.push(markdown.slice(0, maxChars));
    lines.push("");
    lines.push(
      `[cut at ${maxChars} of ${markdown.length} characters; ask with a larger max_chars for more]`,
    );
  } else {
    lines.push(markdown);
  }

  const links = uniqueLinks(page.links ?? []);
  if (links.length > 0) {
    lines.push("");
    lines.push(
      `Links (${Math.min(links.length, MAX_LISTED_LINKS)} of ${links.length}):`,
    );
    for (const link of links.slice(0, MAX_LISTED_LINKS))
      lines.push(`- ${link}`);
  }
  return lines.join("\n");
}

function mapText(links: MappedLink[], url: string): string {
  if (links.length === 0) {
    return `Firecrawl found no addresses on ${url}. The site may block crawling, or the address may not be its home.`;
  }
  const lines = [`${links.length} addresses on ${url}:`];
  for (const link of links) {
    lines.push(link.title ? `- ${link.url} (${link.title})` : `- ${link.url}`);
  }
  return lines.join("\n");
}

function uniqueLinks(links: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** What `find_contacts` answers. Every field is present, empty when nothing was found. */
export type Contacts = {
  site: string;
  emails: string[];
  x: string[];
  linkedin: string[];
  github: string[];
  contact_forms: string[];
  pricing_page: string | null;
  /** Short lines that name a maker, when a page said who built it. */
  maker_hints: string[];
  pages_read: string[];
};

/** Path words that mark the pages a contact is most likely on, in the order worth reading them. */
const CONTACT_PATH_WORDS = [
  "contact",
  "about",
  "team",
  "founder",
  "support",
  "pricing",
  "press",
  "imprint",
  "impressum",
] as const;

const EMAIL_PATTERN =
  /[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

/** Addresses that match the pattern and are never a person: asset names and example domains. */
const EMAIL_NOISE =
  /\.(png|jpe?g|gif|svg|webp|css|js)$|@(example|sentry|2x|3x)\b/i;

/**
 * The composite: home page first, then the pages the home page links to that look like contact
 * pages, then a site map for any it did not link, up to the page budget. Each page's markdown and
 * links are read for addresses and profiles. A page that fails is skipped rather than failing the
 * whole call, because a broken pricing page should not hide a working contact page.
 */
export async function findContacts(
  http: FetchLike,
  instance: { baseUrl: string; apiKey: string; ca?: string },
  url: string,
  maxPages: number,
): Promise<Contacts> {
  const site = new URL(url);
  const found: Contacts = {
    site: site.toString(),
    emails: [],
    x: [],
    linkedin: [],
    github: [],
    contact_forms: [],
    pricing_page: null,
    maker_hints: [],
    pages_read: [],
  };

  /*
   * The pages still worth reading, by how promising their address is. Every page read adds the
   * contact-looking pages it links to, so a home page that only links "About" still leads to the
   * contact page that "About" links to, and the next page read is always the most promising one
   * known so far rather than the next one the home page happened to list.
   */
  const candidates = new Map<string, number>();
  const consider = (links: readonly string[]) => {
    for (const { url: link, rank } of rankedContactPages(links, site)) {
      const known = candidates.get(link);
      if (known === undefined || rank < known) candidates.set(link, rank);
    }
  };
  const attempted = new Set<string>([url]);
  const next = (): string | null => {
    let best: { url: string; rank: number } | null = null;
    for (const [link, rank] of candidates) {
      if (attempted.has(link)) continue;
      if (!best || rank < best.rank) best = { url: link, rank };
    }
    return best?.url ?? null;
  };

  const home = await scrape(http, instance, url, { onlyMainContent: false });
  found.pages_read.push(url);
  harvest(found, home, url);
  consider(home.links ?? []);

  if (candidates.size < 2 && maxPages > 1) {
    try {
      const mapped = await mapSite(http, instance, site.origin, {
        search: "contact about team pricing",
        limit: 30,
      });
      consider(mapped.map((entry) => entry.url));
    } catch {
      // The map is a second chance, not a requirement.
    }
  }

  while (found.pages_read.length < maxPages) {
    const candidate = next();
    if (!candidate) break;
    attempted.add(candidate);
    try {
      const page = await scrape(http, instance, candidate, {
        onlyMainContent: false,
      });
      found.pages_read.push(candidate);
      harvest(found, page, candidate);
      consider(page.links ?? []);
    } catch {
      // Skipped, and said so by its absence from pages_read.
    }
  }

  return found;
}

/**
 * The same site's addresses that look like contact pages, most promising first.
 *
 * Same host only, because a link to somebody else's contact page is a link to somebody else. The
 * ranking is by which word matched, so `/contact` is read before `/pricing` when the budget runs
 * out, and a `mailto:` is not a page at all and is harvested elsewhere.
 */
export function rankContactPages(
  links: readonly string[],
  site: URL,
): string[] {
  return rankedContactPages(links, site).map((entry) => entry.url);
}

/** {@link rankContactPages} with the rank kept, for a caller merging several pages' links. */
function rankedContactPages(
  links: readonly string[],
  site: URL,
): { url: string; rank: number }[] {
  const host = site.hostname.replace(/^www\./, "");
  const ranked: { url: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const raw of links) {
    let parsed: URL;
    try {
      parsed = new URL(raw, site);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.hostname.replace(/^www\./, "") !== host) continue;
    // The site's own spelling of its host, so `www.` and bare name are one page rather than two.
    parsed.hostname = site.hostname;
    parsed.hash = "";
    const key = parsed.toString();
    if (seen.has(key)) continue;
    const path = parsed.pathname.toLowerCase();
    const rank = CONTACT_PATH_WORDS.findIndex((word) => path.includes(word));
    if (rank === -1) continue;
    seen.add(key);
    ranked.push({ url: key, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked;
}

/** Read one page's text and links into the answer, without repeating what is already there. */
export function harvest(found: Contacts, page: ScrapedPage, url: string): void {
  const text = page.markdown ?? "";
  const links = page.links ?? [];

  for (const match of text.match(EMAIL_PATTERN) ?? []) {
    addUnique(found.emails, match.toLowerCase(), EMAIL_NOISE);
  }
  for (const link of links) {
    const lower = link.toLowerCase();
    if (lower.startsWith("mailto:")) {
      const address = link.slice("mailto:".length).split("?")[0] ?? "";
      if (EMAIL_PATTERN.test(address)) {
        addUnique(found.emails, address.toLowerCase(), EMAIL_NOISE);
      }
      EMAIL_PATTERN.lastIndex = 0;
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      continue;
    }
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    if ((host === "x.com" || host === "twitter.com") && isProfilePath(path)) {
      addUnique(found.x, `https://x.com${path}`);
    } else if (
      host === "linkedin.com" &&
      /^\/(in|company)\/[^/]+$/.test(path)
    ) {
      addUnique(found.linkedin, `https://www.linkedin.com${path}`);
    } else if (host === "github.com" && isProfilePath(path)) {
      addUnique(found.github, `https://github.com${path}`);
    }
  }

  const here = safeUrl(url);
  if (here) {
    const path = here.pathname.toLowerCase();
    if (/contact|support/.test(path) && /\[.*\]\(|<form|submit/i.test(text)) {
      addUnique(found.contact_forms, here.toString());
    }
    if (/pricing|plans/.test(path) && found.pricing_page === null) {
      found.pricing_page = here.toString();
    }
  }
  if (found.pricing_page === null) {
    const pricing = links.find((link) => {
      const parsed = safeUrl(link);
      return (
        parsed !== null &&
        /pricing|plans/.test(parsed.pathname.toLowerCase()) &&
        parsed.hostname === (here?.hostname ?? parsed.hostname)
      );
    });
    if (pricing) found.pricing_page = pricing;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.replace(/[#*_>]/g, "").trim();
    if (trimmed.length < 8 || trimmed.length > 160) continue;
    if (
      /\b(made|built|created|founded|founder|maker|by)\b/i.test(trimmed) &&
      /\b(by|founder|maker)\b/i.test(trimmed) &&
      found.maker_hints.length < 5
    ) {
      addUnique(found.maker_hints, trimmed);
    }
  }
}

function isProfilePath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 1) return false;
  const handle = parts[0] ?? "";
  return !/^(intent|share|home|search|login|signup|hashtag|i|explore|settings|features|about|orgs|topics|sponsors|marketplace)$/i.test(
    handle,
  );
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function addUnique(list: string[], value: string, noise?: RegExp): void {
  if (noise?.test(value)) return;
  if (!list.includes(value)) list.push(value);
}
