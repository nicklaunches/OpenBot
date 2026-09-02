import type { SearchConsoleConfig } from "../config";
import {
  apiRequest,
  encodeSite,
  type FetchLike,
  INSPECTION_BASE,
  type InspectionResponse,
  type MintedToken,
  mintAccessToken,
  parseServiceAccount,
  redacted,
  type SearchAnalyticsResponse,
  type SearchAnalyticsRow,
  SearchConsoleError,
  type SiteEntry,
  type SitemapEntry,
  type SitemapsResponse,
  WEBMASTERS_BASE,
} from "../search-console/client";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin transport for Search Console: a Bot reading how this deployment's own sites are doing
 * in Google Search, without leaving the building.
 *
 * WHERE IT SITS BETWEEN THE OTHER TWO BUILTINS. Routines has no credential at all, because it acts on
 * this deployment's own tables and the ACTOR is the authorization. Mailbox has one, a mailbox
 * password, and it is the deployment's rather than anybody's. This is the Mailbox shape: one service
 * account, held by the deployment, used for every Bot granted the tools, and no person consents to
 * it. So the authorization is the GRANT, decided per tool on the Plugins page, exactly as it would be
 * for a vendor's connector.
 *
 * That is why nothing below reads `connection.actorId` as permission. A run that reaches here has
 * already passed the grant check and the policy decision in `plugins/store.ts`, and there is no
 * per-person narrowing left to do: a property's search performance does not have somebody's half.
 *
 * EVERY TOOL IS A READ, which is the one way this differs from Mailbox in kind rather than in
 * subject. The scope asked for is `webmasters.readonly`, the catalogue entry names no write tools,
 * and there is no tool here that submits a sitemap, requests indexing or changes a setting. A
 * deployment granting the whole connector is granting the ability to look.
 *
 * THE CONFIGURED SITE LIST IS THE BOUNDARY, and it is a stronger statement than it looks. A service
 * account accumulates properties: somebody adds it to a second site to fix something, and never
 * removes it. Asking Google what the account can see would therefore widen what a Bot may ask about
 * without anybody deciding to, so a site that is not in `SEARCH_CONSOLE_SITES` is refused HERE,
 * before any request is made, and the refusal names the ones that are configured.
 *
 * THE KEY IS NEVER IN THE ENVIRONMENT and never in an answer. The properties come from `config.ts`;
 * the service-account JSON comes from the encrypted credential vault, resolved through {@link
 * SearchConsoleAccess.credential} at the moment a call needs it and thrown away after. The access
 * token minted from it lives in a cache keyed by the credential's id, so a rotation cannot be
 * answered from the old key's token. {@link redacted} is the last line of both: a failure sentence
 * that carried either one is scrubbed before anybody reads it.
 *
 * It implements the same interface as every other transport, as module-level exports, because that is
 * the shape {@link ./transport} resolves: a `TransportKind` maps to a MODULE. Which is also why the
 * configuration and the vault arrive through {@link useSearchConsole} rather than a constructor: the
 * registry is built at import time, long before `index.ts` has either.
 */

/**
 * What the tools act on: which properties may be asked about, and how to unlock the account.
 *
 * `credential` is a function rather than a string because a secret read once at boot is a secret held
 * in memory for the life of the process and stale the moment an administrator rotates it. Read per
 * call, a rotation takes effect on the next call and a revocation refuses it.
 */
export type SearchConsoleAccess = {
  config: SearchConsoleConfig;
  /**
   * The stored service account, with the vault row's id, or null when this deployment holds none.
   *
   * THE ID IS NOT DECORATION. It is what the access-token cache is keyed by, so a rotated credential
   * is a different key and the token minted from the retired one is never reached again. Without it
   * the cache would happily answer for an hour with a token from a key an administrator has already
   * replaced.
   */
  credential: () => Promise<{ id: string; serviceAccount: string } | null>;
  /**
   * How a service account becomes an access token. Defaults to Google's own library.
   *
   * Injected so a test can exercise the whole connector without a key to sign with and without
   * Google to sign against, which is the same reason `MailboxAccess.clients` exists.
   */
  mintToken?: (serviceAccount: string) => Promise<MintedToken>;
  /**
   * How a request is actually made. Defaults to the global `fetch`.
   *
   * Injected for the property that is otherwise untestable and most worth being sure about: which
   * URL a call went out to. Percent-encoding a property string is the difference between asking
   * about `https://example.com/` and addressing some other endpoint entirely.
   */
  fetch?: FetchLike;
};

/**
 * Which credential in the vault is the service account.
 *
 * Here rather than at the one call site in `index.ts`, because it is a contract with two other
 * parties: the administrator who types these three values at `/admin/credentials`, and
 * `docs/search-console.md`, which tells them to. Three strings agreeing across three places by
 * convention is how a deployment ends up holding the right secret under a key nothing reads.
 *
 * ONE CREDENTIAL, NOT ONE PER SITE, which is where this differs from Mailbox. A mailbox password
 * unlocks exactly one mailbox, so the address is the key id. A service account is verified for
 * however many properties somebody added it to, so there is one secret for all of them and the key id
 * is a constant. Which properties it may be spent on is `SEARCH_CONSOLE_SITES`, not the vault.
 *
 * `mcp` is the kind because that is the vault's name for "the one token this deployment holds for
 * this server", which is the same kind a custom MCP server's own bearer token is stored under and the
 * same thing a service-account key is here: one secret, the deployment's, used for every Bot granted
 * the tools.
 */
export function searchConsoleCredential(): {
  kind: "mcp";
  provider: "search-console";
  keyId: string;
} {
  return { kind: "mcp", provider: "search-console", keyId: "service-account" };
}

let installed: SearchConsoleAccess | null = null;

/**
 * The access token, and which credential minted it.
 *
 * A module-level cache rather than a per-call mint, because a token is good for an hour and minting
 * one is an RS256 signature plus a round trip to Google's token endpoint. Doing that on every tool
 * call would put a second network hop in front of every question a Bot asks, to obtain something that
 * was already valid.
 *
 * KEYED BY CREDENTIAL ID, which is what makes rotation safe rather than merely fast: a new vault row
 * has a new id, so the cached entry no longer matches and the next call mints from the key that is
 * actually stored. A revoked credential never reaches here at all, because the closure that reads it
 * returns nothing.
 */
let cachedToken: {
  credentialId: string;
  token: string;
  expiresAt: number;
} | null = null;

/**
 * How long before expiry a cached token stops being used.
 *
 * A token that expires while a request is in flight is a 401 in the middle of somebody's turn, and
 * the clock this process reads is not the clock Google checks against. A minute covers both the
 * request that is about to be made and any ordinary skew between the two.
 */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Hand this module its configuration and its vault, once, from the place that has both.
 *
 * A module-level binding rather than a constructor argument, for the reason {@link
 * ./builtin-mailbox.useMailbox} gives: `transportFor` resolves a kind to a MODULE and there is no seam
 * to pass anything through. `null` is a supported argument, and not only for symmetry: the suite is
 * one process, so a test that installs a stub has to be able to take it back out again, and a
 * deployment with no properties configured installs nothing.
 *
 * The token cache is emptied here rather than left alone. A cached token belongs to the access that
 * was installed, and one surviving a swap would be this deployment answering a new configuration's
 * first call with the old one's credential.
 */
export function useSearchConsole(access: SearchConsoleAccess | null): void {
  installed = access;
  cachedToken = null;
}

/** The dimensions Search Console can break search analytics down by. */
const DIMENSIONS = [
  "query",
  "page",
  "country",
  "device",
  "date",
  "searchAppearance",
] as const;

/** The comparisons a dimension filter can make. */
const FILTER_OPERATORS = [
  "equals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;

/** The surfaces a query can be asked about. `web` is the one nearly every question means. */
const SEARCH_TYPES = [
  "web",
  "image",
  "video",
  "news",
  "discover",
  "googleNews",
] as const;

/** Bounds on how many rows one search analytics call may return. See {@link boundedRows}. */
const ROW_LIMIT = { fallback: 50, max: 250 } as const;

/**
 * How far behind today the default window ends.
 *
 * NOT A ROUNDING CHOICE. Search Console's data lags: the last two days are usually incomplete and
 * sometimes absent, so a window ending today reports a collapse in traffic that did not happen, and a
 * model asked "how did we do this week" will report it. Ending three days back means every day in the
 * default window is a day Google has finished counting.
 */
const DATA_LAG_DAYS = 3;

/** How many days the default window covers, counting both ends. Four weeks, so weekdays balance. */
const DEFAULT_WINDOW_DAYS = 28;

/**
 * What a call answers when this deployment has no properties configured.
 *
 * Names both halves, including the one that is not an environment variable, because the half a reader
 * is most likely to be missing is the half that is not in `.env`. The catalogue entry stays admissible
 * and grantable without either (see `DeploymentConfig.searchConsole`), so this sentence, rather than a
 * missing connector, is how a deployment finds out.
 */
const NOT_CONFIGURED =
  "Search Console is not configured. Set SEARCH_CONSOLE_SITES to the properties this deployment may ask about, and store the service-account key file as the search-console credential (kind `mcp`, provider `search-console`, key id `service-account`).";

/**
 * What a call answers when the properties are configured and the vault holds no service account.
 *
 * Its own sentence rather than the one above, because it is a different job with a different fix: an
 * administrator has already set the variable and has one step left, at a different screen. Telling
 * them to set a variable they can see is already set is how a correct instruction gets read as a
 * broken deployment.
 */
const NO_CREDENTIAL =
  "This deployment holds no Search Console service account. An administrator has to store the key file Google Cloud downloaded as the search-console credential (kind `mcp`, provider `search-console`, key id `service-account`), and give that service account access to each property in Search Console, before anything can be read.";

/**
 * The `site` argument, in the one wording every tool that takes one uses.
 *
 * IT SAYS THE PROPERTY IS A STRING RATHER THAN A DOMAIN, and that sentence is the whole point of this
 * constant. Search Console does not have "example.com" as a thing you can ask about: it has
 * `sc-domain:example.com` and `https://example.com/`, they are different properties, and a model that
 * types the bare domain is refused by Google with a permission error about a property that does not
 * exist. Naming both spellings here costs two lines and saves a round trip.
 */
const SITE_ARGUMENT = Object.freeze({
  type: "string",
  description:
    "Which Search Console property to ask about, spelled exactly as it is configured: `sc-domain:example.com` for a domain property or `https://example.com/` for a URL-prefix one. A bare domain is not a property. Use `list_sites` if you are not sure which this deployment has.",
} as const);

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_sites",
    description: [
      "List the Search Console properties this deployment may ask about, with the access level Google",
      "reports for each. Start here when you do not already know the exact property string: every other",
      "tool takes one, and they are not interchangeable with a bare domain.",
      "",
      "This is the deployment's own list, not everything the account can see. A property that is not",
      "listed cannot be asked about, and that is a configuration decision rather than a permissions one.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_analytics",
    description: [
      "How a property performed in Google Search: clicks, impressions, click-through rate and average",
      "position, broken down by whichever dimensions you ask for.",
      "",
      '`dimensions` decides what each row IS. `["query"]`, the default, gives one row per search term;',
      '["page"] gives one row per URL; ["date"] gives one row per day, which is what a trend question',
      'wants; ["query", "page"] gives one row per pair. Ask for what the question needs and no more, since',
      "every extra dimension splits the same clicks across more rows.",
      "",
      "The default window is the 28 days ending three days ago. That end is deliberate: Search Console's",
      "data lags by a couple of days, so a window ending today shows a fall in traffic that did not",
      "happen. Say so if somebody asks about yesterday.",
      "",
      "Rows come back sorted by clicks, most first, and a row limit means you are seeing the top of the",
      "list rather than all of it. Position is an average, so a small number of impressions moves it a",
      "long way; say how many impressions a claim rests on before calling a position good or bad.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        site: SITE_ARGUMENT,
        start_date: {
          type: "string",
          description:
            "First day of the window, as YYYY-MM-DD. Defaults to 28 days before the end date.",
        },
        end_date: {
          type: "string",
          description:
            "Last day of the window, as YYYY-MM-DD. Defaults to three days ago, because the most recent days are incomplete.",
        },
        dimensions: {
          type: "array",
          items: { type: "string", enum: [...DIMENSIONS] },
          description: `What each row is broken down by, in order: ${DIMENSIONS.join(", ")}. Default ["query"].`,
        },
        filters: {
          type: "array",
          description:
            "Narrow the rows, all conditions having to hold at once. Each entry is {dimension, operator, expression}.",
          items: {
            type: "object",
            properties: {
              dimension: { type: "string", enum: [...DIMENSIONS] },
              operator: {
                type: "string",
                enum: [...FILTER_OPERATORS],
                description: "Default equals.",
              },
              expression: {
                type: "string",
                description:
                  "What to compare against: the exact query, the full page URL, a country as its three-letter code, or a device as DESKTOP, MOBILE or TABLET.",
              },
            },
            required: ["dimension", "expression"],
          },
        },
        search_type: {
          type: "string",
          enum: [...SEARCH_TYPES],
          description: `Which surface to report on: ${SEARCH_TYPES.join(", ")}. Default web, which is what nearly every question means.`,
        },
        row_limit: {
          type: "integer",
          description: `How many rows to return, most clicks first. Default ${ROW_LIMIT.fallback}, at most ${ROW_LIMIT.max}.`,
        },
        start_row: {
          type: "integer",
          description:
            "Where to start in the sorted list, for reading past the first page. Default 0.",
        },
      },
      required: ["site"],
    },
  },
  {
    name: "inspect_url",
    description: [
      "Ask Google what it knows about one URL on a property: whether it is indexed, when it was last",
      "crawled, which canonical Google chose against the one the page declares, and whether robots.txt",
      "or a fetch failure got in the way.",
      "",
      'This is the tool for "why isn\'t this page showing up". A verdict of PASS with a coverage state',
      "saying the URL is on Google means it is indexed; anything else, the coverage state is the sentence",
      "worth repeating, because it names which of a dozen different problems this is.",
      "",
      "Google canonical and user canonical differing is the most commonly misread result here: it means",
      "Google is indexing a different URL than the page asked it to, which is a real finding rather than",
      "an error.",
      "",
      "QUOTA: 2000 inspections per property per day, and it is Google's, shared with anybody else using",
      "it. Inspect the URLs a question is actually about rather than sweeping a site with it.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        site: SITE_ARGUMENT,
        url: {
          type: "string",
          description:
            "The full URL to inspect, including the scheme. It has to be inside the property.",
        },
      },
      required: ["site", "url"],
    },
  },
  {
    name: "list_sitemaps",
    description: [
      "The sitemaps submitted for a property: when each was last submitted and last downloaded, whether",
      "Google is still processing it, how many errors and warnings it has, and how many URLs of each type",
      "it declares against how many Google has indexed.",
      "",
      "Submitted and indexed counts differing is normal and is not by itself a problem; a large gap, or a",
      "sitemap Google has not downloaded since long before its last submission, is worth saying out loud.",
      "",
      "This reads the list. Nothing here submits or deletes a sitemap.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { site: SITE_ARGUMENT },
      required: ["site"],
    },
  },
]);

/**
 * Who this call is for, and which Bot is making it.
 *
 * The whole shared connection shape, all of it unused: there is no host to dial from a URL, no token
 * to send from the server row, and the actor is not what authorizes this one. Declared anyway because
 * it is the transport interface, and named here so the reason is written down where somebody would
 * look for a missing check.
 */
type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

/**
 * The list is static and needs neither a credential nor a configured property.
 *
 * The four definitions are schemas in this file: nothing to discover, nobody to ask. Listing them
 * without a configured deployment is deliberate rather than an oversight. An administrator sets a
 * connector up and grants its tools before, or instead of, the deployment ever having the secret, and
 * a tool list that emptied itself when a variable was unset would revoke grants by accident.
 */
export async function listTools(): Promise<McpTool[]> {
  const sites = installed?.config.sites ?? null;
  return TOOLS.map((tool) => withSites(tool, sites));
}

/**
 * One tool definition, with the configured properties named in it.
 *
 * ADDED HERE RATHER THAN WRITTEN INTO {@link TOOLS} because the choices are a deployment's, not this
 * file's. A model that is told the property strings can pick one; a model told only that a `site`
 * argument exists has to guess at a string, and a guessed property is a refusal at best. The names are
 * already in front of it the moment it calls `list_sites`, so naming them in the description reveals
 * nothing a granted Bot could not already read.
 *
 * `list_sites` is left alone, because it takes no site and its whole job is to answer this question.
 */
function withSites(tool: McpTool, sites: readonly string[] | null): McpTool {
  if (tool.name === "list_sites") return { ...tool };

  const configured = sites && sites.length > 0 ? sites : null;
  const named = configured
    ? `This deployment's properties are: ${configured.join(", ")}. Anything else is refused before any request is made.`
    : "This deployment has no properties configured yet, so every call refuses and says what to set.";

  return {
    ...tool,
    description: [tool.description, "", named].join("\n"),
  };
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
 * A string of digits counts, for the reason {@link ./builtin-mailbox.integerArg} gives: models produce
 * `"50"` for an integer field often enough that refusing it would be refusing a correct intention over
 * a JSON type. Anything else that is not a whole number at least `minimum` is refused rather than
 * rounded, because silently turning `12.7` into 12 answers a question nobody asked.
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

/**
 * How many rows one call returns, and whether the ask was cut down.
 *
 * Capped rather than refused, which is the opposite of what this file does with a malformed number,
 * and the difference is what the number means. A malformed `start_row` is a mistake only the model can
 * fix; "give me 1000 rows" is a perfectly clear intention that this tool simply does not serve, and
 * refusing it would cost a whole round trip to be told a smaller number. The cap is SAID, in the
 * answer, so a model that asked for 1000 and got 250 knows there may be more rather than concluding
 * the property has 250 queries.
 */
export function boundedRows(asked: number | undefined): {
  limit: number;
  capped: boolean;
} {
  if (asked === undefined) return { limit: ROW_LIMIT.fallback, capped: false };
  if (asked > ROW_LIMIT.max) return { limit: ROW_LIMIT.max, capped: true };
  return { limit: asked, capped: false };
}

/**
 * Two property strings compared as the same property.
 *
 * Case-folded, and a trailing slash ignored. Both are spellings a person genuinely produces of one
 * property: a URL-prefix property is `https://example.com/` in Search Console and gets typed without
 * the slash by everybody, and `SC-Domain:` is the same domain property as `sc-domain:`. What is SENT
 * to Google is always the configured spelling, never the caller's, so tolerance here cannot become a
 * request to something else.
 */
const sameSite = (one: string): string =>
  one.trim().toLowerCase().replace(/\/+$/, "");

/**
 * Which property this call is about.
 *
 * A SITE THAT IS NOT CONFIGURED IS REFUSED HERE, before the vault is read and long before anything is
 * dialled, and the refusal lists the ones that exist. The service account can very well see the
 * property that was asked for — that is exactly the case this exists for. Somebody adds the account to
 * another site to fix something, never removes it, and from that moment Google would happily answer a
 * question about a property nobody decided this deployment's Bots could ask about. The configured list
 * is the decision; Google's answer is not.
 *
 * The configured spelling is returned rather than the caller's, so what goes into a URL is always a
 * string an administrator wrote.
 */
export function selectSite(
  args: Record<string, unknown>,
  sites: readonly string[],
): { site?: string; error?: string } {
  const asked = stringArg(args, "site");
  if (asked === undefined) {
    return {
      error: `Say which property to ask about, as \`site\`. This deployment has ${sites.join(", ")}.`,
    };
  }

  const wanted = sameSite(asked);
  const configured = sites.find((site) => sameSite(site) === wanted);
  if (!configured) {
    return {
      error: `${asked} is not one of this deployment's Search Console properties. It has ${sites.join(", ")}. Nothing was requested.`,
    };
  }
  return { site: configured };
}

/**
 * A day as Search Console spells it, from epoch milliseconds, in UTC.
 *
 * Empty for a timestamp that is not one, rather than throwing. `new Date(NaN).toISOString()` raises,
 * and the one caller that can hand it a NaN is the check that exists to catch `2026-13-01` — so the
 * validator would fail with a stack instead of the sentence it was written to produce.
 */
const asDay = (at: number): string =>
  Number.isNaN(at) ? "" : new Date(at).toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/**
 * The window a call covers when it named neither end.
 *
 * `now` is a parameter with a default rather than a constant read inside, so the behaviour can be
 * asserted against a fixed clock instead of against whatever day the suite happens to run on.
 *
 * Both ends are pulled back by {@link DATA_LAG_DAYS}. See that constant: a window ending today reports
 * a fall in traffic that did not happen, and a model will report it as news.
 */
export function defaultWindow(now: number = Date.now()): {
  startDate: string;
  endDate: string;
} {
  const end = now - DATA_LAG_DAYS * DAY_MS;
  return {
    startDate: asDay(end - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS),
    endDate: asDay(end),
  };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Which days this call covers.
 *
 * A date that is not `YYYY-MM-DD` is refused rather than passed on, because Google's own complaint
 * about one is a 400 naming a field rather than a format, and a model reading it retries with the
 * same shape. The round-trip check catches `2026-02-30`, which matches the pattern and is not a day.
 *
 * ONE END GIVEN AND NOT THE OTHER IS AN ANSWER, not a mistake: an end date on its own means the 28
 * days before it, and a start date on its own means from there to where the default window ends. A
 * model that named one end has said something clear, and refusing it would spend a turn teaching a
 * lesson about an argument it got right.
 */
export function dateWindow(
  args: Record<string, unknown>,
  now: number = Date.now(),
): { startDate?: string; endDate?: string; error?: string } {
  const fallback = defaultWindow(now);

  for (const key of ["start_date", "end_date"]) {
    const given = stringArg(args, key);
    if (given === undefined) continue;
    if (
      !DAY_PATTERN.test(given) ||
      asDay(Date.parse(`${given}T00:00:00Z`)) !== given
    ) {
      return {
        error: `\`${key}\` has to be a date as YYYY-MM-DD, such as ${fallback.endDate}. ${given} is not one.`,
      };
    }
  }

  const endDate = stringArg(args, "end_date") ?? fallback.endDate;
  const startDate =
    stringArg(args, "start_date") ??
    asDay(
      Date.parse(`${endDate}T00:00:00Z`) - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS,
    );

  if (startDate > endDate) {
    return {
      error: `The window runs backwards: start_date ${startDate} is after end_date ${endDate}.`,
    };
  }
  return { startDate, endDate };
}

/**
 * What each row is broken down by.
 *
 * A bare string is accepted as well as an array, and a comma-separated one is split, because a model
 * asked for an array of enums produces `"query"` and `"query,page"` often enough that refusing them
 * would be refusing a clear intention over a JSON type. An unknown name is refused and the refusal
 * lists the six, since a model told only that its dimension was invalid guesses another.
 */
export function selectDimensions(args: Record<string, unknown>): {
  dimensions?: string[];
  error?: string;
} {
  const raw = args.dimensions;
  if (raw === undefined || raw === null || raw === "") {
    return { dimensions: ["query"] };
  }

  const asked =
    typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : null;
  if (asked === null) {
    return {
      error: `\`dimensions\` has to be a list of ${DIMENSIONS.join(", ")}.`,
    };
  }

  const chosen: string[] = [];
  for (const entry of asked) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const name = entry.trim();
    const known = DIMENSIONS.find(
      (dimension) => dimension.toLowerCase() === name.toLowerCase(),
    );
    if (!known) {
      return {
        error: `${name} is not a Search Console dimension. The dimensions are ${DIMENSIONS.join(", ")}.`,
      };
    }
    // Deduplicated rather than refused: asking for the same breakdown twice is a clear intention that
    // Google answers with a 400, and there is exactly one thing it can have meant.
    if (!chosen.includes(known)) chosen.push(known);
  }

  if (chosen.length === 0) {
    return {
      error: `\`dimensions\` was empty. Give at least one of ${DIMENSIONS.join(", ")}, or leave it out for query.`,
    };
  }
  return { dimensions: chosen };
}

type DimensionFilter = {
  dimension: string;
  operator: string;
  expression: string;
};

/**
 * The conditions the rows have to satisfy, checked before anything is sent.
 *
 * Every filter is checked rather than the first bad one being sent on, because Google answers a
 * malformed group with a single 400 that names neither which filter nor which field, and a model
 * handed that will rewrite the whole call.
 *
 * The operator defaults to `equals`, which is what a filter written without one means everywhere else
 * it appears. A regex operator's expression is NOT compiled here: Google evaluates it with RE2, this
 * process would evaluate it with JavaScript's engine, and a check that accepted a different language
 * from the one that runs would be worse than no check.
 */
export function selectFilters(args: Record<string, unknown>): {
  filters?: DimensionFilter[];
  error?: string;
} {
  const raw = args.filters;
  if (raw === undefined || raw === null || raw === "") return { filters: [] };
  if (!Array.isArray(raw)) {
    return {
      error:
        "`filters` has to be a list of {dimension, operator, expression} entries.",
    };
  }

  const filters: DimensionFilter[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return {
        error:
          "Each entry in `filters` has to be an object with a dimension, an operator and an expression.",
      };
    }
    const one = entry as Record<string, unknown>;

    const dimension = DIMENSIONS.find(
      (name) =>
        typeof one.dimension === "string" &&
        name.toLowerCase() === one.dimension.trim().toLowerCase(),
    );
    if (!dimension) {
      return {
        error: `A filter names the dimension ${String(one.dimension)}, which is not one. The dimensions are ${DIMENSIONS.join(", ")}.`,
      };
    }

    const asked =
      typeof one.operator === "string" && one.operator.trim() !== ""
        ? one.operator.trim()
        : "equals";
    const operator = FILTER_OPERATORS.find(
      (name) => name.toLowerCase() === asked.toLowerCase(),
    );
    if (!operator) {
      return {
        error: `A filter uses the operator ${asked}, which is not one. The operators are ${FILTER_OPERATORS.join(", ")}.`,
      };
    }

    const expression =
      typeof one.expression === "string" ? one.expression.trim() : "";
    if (expression === "") {
      return {
        error: `The ${dimension} filter has nothing to compare against. Give an \`expression\`.`,
      };
    }

    filters.push({ dimension, operator, expression });
  }
  return { filters };
}

/** Which surface the question is about. Unknown is refused rather than quietly turned into web. */
export function selectSearchType(args: Record<string, unknown>): {
  searchType?: string;
  error?: string;
} {
  const asked = stringArg(args, "search_type");
  if (asked === undefined) return { searchType: "web" };
  const known = SEARCH_TYPES.find(
    (type) => type.toLowerCase() === asked.toLowerCase(),
  );
  if (!known) {
    return {
      error: `${asked} is not a Search Console search type. They are ${SEARCH_TYPES.join(", ")}.`,
    };
  }
  return { searchType: known };
}

/**
 * A number of rows as a fixed-width table.
 *
 * A table rather than one line per row, because the whole point of this answer is comparison: a model
 * reading fifty rows of "query, clicks, impressions" prose has to hold the columns in its head, and a
 * person reading the transcript cannot scan it at all. Columns are padded to the widest cell so the
 * numbers line up, and numeric columns are right-aligned so a bigger number is visibly bigger.
 */
export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  rightAlignFrom: number,
): string {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[column] ?? "").length),
      // A column with no rows still gets its header's width, and `Math.max` of an empty spread is
      // -Infinity, so the header length is included above rather than relied on afterwards.
      0,
    ),
  );

  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) =>
        column >= rightAlignFrom
          ? (cell ?? "").padStart(widths[column])
          : (cell ?? "").padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();

  return [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

/** A rate as a percentage with one decimal, which is how everybody reads and quotes a CTR. */
const asPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

/** An average position with one decimal. More would assert a precision the average does not have. */
const asPosition = (position: number): string => position.toFixed(1);

/**
 * Search analytics rows as something a model can read and quote.
 *
 * THE TOTALS LINE IS ABOUT THE ROWS SHOWN, and says so, because it cannot be about anything else: the
 * API returns a page of the sorted list and never says how large the list was. A totals line that read
 * as the property's whole traffic would be a number a model repeats to somebody as the site's
 * performance, which it is not.
 *
 * The average position is weighted by impressions rather than averaged flat. A query with three
 * impressions at position 90 and one with three thousand at position 4 do not average to 47 in any
 * sense anybody means, and a flat mean is the standard way this metric gets misreported.
 */
export function analyticsTable(
  rows: readonly SearchAnalyticsRow[],
  dimensions: readonly string[],
): string {
  const headers = [...dimensions, "clicks", "impressions", "ctr", "position"];
  const body = rows.map((row) => [
    ...dimensions.map((_dimension, index) => row.keys?.[index] ?? "(none)"),
    String(row.clicks ?? 0),
    String(row.impressions ?? 0),
    asPercent(row.ctr ?? 0),
    asPosition(row.position ?? 0),
  ]);

  const clicks = rows.reduce((sum, row) => sum + (row.clicks ?? 0), 0);
  const impressions = rows.reduce(
    (sum, row) => sum + (row.impressions ?? 0),
    0,
  );
  const weighted = rows.reduce(
    (sum, row) => sum + (row.position ?? 0) * (row.impressions ?? 0),
    0,
  );

  const totals = [
    `Totals across these ${rows.length} rows: ${clicks} clicks, ${impressions} impressions`,
    impressions > 0 ? `${asPercent(clicks / impressions)} ctr` : null,
    impressions > 0
      ? `average position ${asPosition(weighted / impressions)}, weighted by impressions`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return [table(headers, body, dimensions.length), "", `${totals}.`].join("\n");
}

/** One inspection field as a line, or nothing at all when Google said nothing about it. */
const field = (label: string, value: unknown): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? `${label}: ${value}`
    : null;

/**
 * What Google knows about one URL, in the order somebody reads it.
 *
 * The verdict first because it is the answer, then the coverage state because it is the reason, then
 * the crawl facts, then the canonicals. Anything Google did not say is left out rather than printed
 * as "unknown": a model reading a page of "unknown" concludes the tool failed.
 *
 * THE TWO CANONICALS ARE PUT TOGETHER, on purpose. Apart, they are two URLs a model reports
 * separately; together, the fact that they differ is the finding, and that difference is the single
 * most common real cause of a page that is crawled and not indexed.
 */
export function inspectionInWords(
  body: InspectionResponse,
  url: string,
  site: string,
): string {
  const result = body.inspectionResult;
  if (!result) {
    return `Google returned no inspection result for ${url} in ${site}.`;
  }
  const status = result.indexStatusResult ?? {};

  const lines = [
    `${url} in ${site}`,
    field("Verdict", status.verdict),
    field("Coverage", status.coverageState),
    field("Indexing", status.indexingState),
    field("Last crawled", status.lastCrawlTime),
    field("Crawled as", status.crawledAs),
    field("robots.txt", status.robotsTxtState),
    field("Page fetch", status.pageFetchState),
  ].filter((line): line is string => line !== null);

  const google = status.googleCanonical;
  const declared = status.userCanonical;
  if (google || declared) {
    lines.push(
      `Canonical: Google uses ${google ?? "none it stated"}, the page declares ${declared ?? "none"}${
        google && declared && google !== declared
          ? " — they differ, so Google is indexing a different URL than the page asked for"
          : ""
      }`,
    );
  }
  if (status.sitemap && status.sitemap.length > 0) {
    lines.push(`Referenced by sitemaps: ${status.sitemap.join(", ")}`);
  }

  const mobile = result.mobileUsabilityResult?.verdict;
  if (mobile) lines.push(`Mobile usability: ${mobile}`);
  const rich = result.richResultsResult?.verdict;
  if (rich) lines.push(`Rich results: ${rich}`);
  const amp = result.ampResult?.verdict;
  if (amp) lines.push(`AMP: ${amp}`);

  if (result.inspectionResultLink) {
    lines.push(`In Search Console: ${result.inspectionResultLink}`);
  }
  return lines.join("\n");
}

/** One sitemap as a block. Counts are per content type, because that is how Google reports them. */
function sitemapInWords(sitemap: SitemapEntry): string {
  const lines = [
    `- ${sitemap.path ?? "(no path)"}`,
    field("  submitted", sitemap.lastSubmitted),
    field("  downloaded", sitemap.lastDownloaded),
  ].filter((line): line is string => line !== null);

  if (sitemap.lastDownloaded === undefined) {
    // Said in words, because an absent field reads as a formatting gap rather than as the fact that
    // Google has never fetched this sitemap, which is the whole answer to "why is it not indexed".
    lines.push("  downloaded: never");
  }

  const state = [
    sitemap.isPending ? "still being processed" : null,
    sitemap.isSitemapsIndex ? "a sitemap index" : null,
    sitemap.type ? `type ${sitemap.type}` : null,
    `${sitemap.errors ?? 0} errors`,
    `${sitemap.warnings ?? 0} warnings`,
  ].filter((part): part is string => part !== null);
  lines.push(`  ${state.join(", ")}`);

  for (const content of sitemap.contents ?? []) {
    lines.push(
      `  ${content.type ?? "urls"}: ${content.submitted ?? 0} submitted, ${content.indexed ?? 0} indexed`,
    );
  }
  return lines.join("\n");
}

/**
 * The service account's private key out of what is stored, for redaction and nothing else.
 *
 * Tolerant where {@link parseServiceAccount} is strict: this is asked on the failure path, where the
 * credential may well be the malformed thing that caused the failure, and a redaction helper that
 * threw would replace a useful sentence with a less useful one.
 */
function privateKeyOf(serviceAccount: string | null): string | null {
  if (!serviceAccount) return null;
  try {
    return parseServiceAccount(serviceAccount).private_key;
  } catch {
    return null;
  }
}

/**
 * An access token for this credential, minted or remembered.
 *
 * See {@link cachedToken} for why it is cached and why the credential's id is the key. The skew is
 * subtracted rather than compared exactly, so a token that is about to expire is replaced before it is
 * spent rather than after it fails.
 */
async function tokenFor(
  access: SearchConsoleAccess,
  credential: { id: string; serviceAccount: string },
): Promise<string> {
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.credentialId === credential.id &&
    cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > now
  ) {
    return cachedToken.token;
  }

  const minted = await (access.mintToken ?? mintAccessToken)(
    credential.serviceAccount,
  );
  cachedToken = {
    credentialId: credential.id,
    token: minted.token,
    expiresAt: minted.expiresAt,
  };
  return minted.token;
}

/**
 * Call one tool.
 *
 * The grant and the policy are already settled by the time anything gets here: `plugins/store.ts`
 * checks what this Bot was given, evaluates the policy against the tool's effect, and writes the audit
 * row, exactly as it does for a vendor's server. There is no second path to Search Console and nothing
 * here re-decides any of that.
 *
 * Nothing thrown escapes. A token endpoint that refused, a request that timed out or an answer that
 * was not what it claimed comes back as an `isError` result rather than as a throw, which is what the
 * vendor transports do and what `plugins/tools.ts` expects.
 */
export async function callTool(
  _connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const access = installed;
  if (!access) return failure(NOT_CONFIGURED);

  /*
   * THE SITE IS SETTLED BEFORE THE VAULT IS READ, which is the whole ordering that matters in this
   * function. A property this deployment did not configure is refused without a credential being
   * decrypted, a token being minted or a request being made, so a model that named a site it should
   * not reach costs nothing and learns which ones it may.
   */
  let site: string | null = null;
  if (toolName !== "list_sites") {
    const chosen = selectSite(args, access.config.sites);
    if (chosen.error || !chosen.site) {
      return failure(chosen.error ?? NOT_CONFIGURED);
    }
    site = chosen.site;
  }

  let serviceAccount: string | null = null;
  let token: string | null = null;
  try {
    const credential = await access.credential();
    if (!credential) return failure(NO_CREDENTIAL);
    serviceAccount = credential.serviceAccount;
    token = await tokenFor(access, credential);

    const http = access.fetch ?? (fetch as unknown as FetchLike);
    const result = await runTool(access, http, token, site, toolName, args);
    /*
     * EVERY ANSWER GOES THROUGH THE SCRUB, not only the ones from the failure path below.
     *
     * A refusal built from Google's own sentence never reaches the `catch`, because it is returned
     * rather than thrown, and an HTTP client that put the request's `Authorization` header into the
     * error it raised would have that sentence carry the token. One pass here covers the successful
     * answers, the vendor's refusals and anything a future tool adds, which is the only version of
     * this rule that does not depend on remembering it at each call site.
     */
    return {
      ...result,
      text: redacted(result.text, [
        privateKeyOf(serviceAccount),
        serviceAccount,
        token,
      ]),
    };
  } catch (error) {
    /*
     * The failure's own sentence, scrubbed of the key and the token and nothing else.
     *
     * It is the most useful thing available, since "invalid_grant", "Search Console API has not been
     * used in project ..." and a signing failure each name a different fix, and rewording it here
     * would turn a specific failure into a vague one. Capped, because a failure is not a promise
     * about length.
     */
    const message =
      error instanceof SearchConsoleError || error instanceof Error
        ? error.message
        : String(error);
    return failure(
      redacted(message, [
        privateKeyOf(serviceAccount),
        serviceAccount,
        token,
      ]).slice(0, 400),
    );
  }
}

/** The work itself, once the property and the token are settled. */
async function runTool(
  access: SearchConsoleAccess,
  http: FetchLike,
  token: string,
  site: string | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName === "list_sites") {
    /*
     * Asked one property at a time rather than through `sites.list`, and the reason is the boundary
     * this connector is built on. `sites.list` answers with everything the service account can see,
     * which is a list this deployment has not decided anybody may ask about, and it would arrive here
     * needing to be filtered against the configured list anyway. Asking about the configured ones
     * means the wider list is never in this process at all.
     */
    const lines: string[] = [];
    for (const configured of access.config.sites) {
      const answer = await apiRequest(
        http,
        token,
        `${WEBMASTERS_BASE}/sites/${encodeSite(configured)}`,
      );
      if (!answer.ok) {
        // Per site rather than for the whole call: a deployment whose account has lost access to one
        // property still has a working connector for the others, and the sentence says which is
        // which.
        lines.push(`- ${configured} · ${answer.message}`);
        continue;
      }
      const entry = answer.body as SiteEntry;
      lines.push(
        `- ${configured} · ${entry.permissionLevel ?? "no permission level reported"}`,
      );
    }
    return asResult(
      [
        `This deployment may ask about ${access.config.sites.length} Search Console ${access.config.sites.length === 1 ? "property" : "properties"}:`,
        ...lines,
      ].join("\n"),
    );
  }

  if (site === null) {
    // Unreachable through `callTool`, which settles the site for every tool but `list_sites` before
    // this function is entered. Named rather than asserted, so a future tool added without a site
    // fails with a sentence instead of a type assertion.
    return failure(
      `${toolName} needs a property, and none was settled. This is a bug in the connector rather than in the call.`,
    );
  }

  if (toolName === "search_analytics") {
    const window = dateWindow(args);
    if (window.error || !window.startDate || !window.endDate) {
      return failure(window.error ?? NOT_CONFIGURED);
    }
    const dimensions = selectDimensions(args);
    if (dimensions.error || !dimensions.dimensions) {
      return failure(dimensions.error ?? NOT_CONFIGURED);
    }
    const filters = selectFilters(args);
    if (filters.error || !filters.filters) {
      return failure(filters.error ?? NOT_CONFIGURED);
    }
    const searchType = selectSearchType(args);
    if (searchType.error || !searchType.searchType) {
      return failure(searchType.error ?? NOT_CONFIGURED);
    }
    const asked = integerArg(args, "row_limit", 1);
    if (asked.error) return failure(asked.error);
    const { limit, capped } = boundedRows(asked.value);
    const startRow = integerArg(args, "start_row", 0);
    if (startRow.error) return failure(startRow.error);

    const answer = await apiRequest(
      http,
      token,
      `${WEBMASTERS_BASE}/sites/${encodeSite(site)}/searchAnalytics/query`,
      {
        startDate: window.startDate,
        endDate: window.endDate,
        dimensions: dimensions.dimensions,
        type: searchType.searchType,
        rowLimit: limit,
        startRow: startRow.value ?? 0,
        /*
         * Finalised data only. `all` includes the last day or two Google is still counting, which
         * arrives as a real number that is wrong in one direction, and a model comparing it to the
         * days around it reports a drop that does not exist.
         */
        dataState: "final",
        ...(filters.filters.length > 0
          ? {
              dimensionFilterGroups: [
                { groupType: "and", filters: filters.filters },
              ],
            }
          : {}),
      },
    );
    if (!answer.ok) return failure(answer.message);

    const rows = (answer.body as SearchAnalyticsResponse).rows ?? [];
    const where = `${site}, ${window.startDate} to ${window.endDate}, ${searchType.searchType} search, by ${dimensions.dimensions.join(" and ")}`;
    if (rows.length === 0) {
      // Said in words rather than returned as an empty table: an empty result reads to a model as
      // "the tool had nothing to say" and gets filled in from memory.
      return asResult(
        `No search data for ${where}. Either nothing was searched for in that window, or the filters matched nothing.`,
      );
    }

    const notes = [
      `[showing ${rows.length} ${rows.length === 1 ? "row" : "rows"} from row ${startRow.value ?? 0}, sorted by clicks.]`,
    ];
    if (capped) {
      notes.push(
        `[${ROW_LIMIT.max} is the most this tool returns at once, so there may be more than these.]`,
      );
    }
    if (rows.length < limit) {
      notes.push(
        `[the API returned ${rows.length} of the ${limit} rows asked for, so this is the end of the data.]`,
      );
    }

    return asResult(
      [
        where,
        "",
        analyticsTable(rows, dimensions.dimensions),
        "",
        ...notes,
      ].join("\n"),
    );
  }

  if (toolName === "inspect_url") {
    const url = stringArg(args, "url");
    if (!url) return failure("Say which URL to inspect, as `url`.");

    const answer = await apiRequest(
      http,
      token,
      `${INSPECTION_BASE}/urlInspection/index:inspect`,
      { inspectionUrl: url, siteUrl: site },
    );
    if (!answer.ok) return failure(answer.message);

    return asResult(
      inspectionInWords(answer.body as InspectionResponse, url, site),
    );
  }

  if (toolName === "list_sitemaps") {
    const answer = await apiRequest(
      http,
      token,
      `${WEBMASTERS_BASE}/sites/${encodeSite(site)}/sitemaps`,
    );
    if (!answer.ok) return failure(answer.message);

    const sitemaps = (answer.body as SitemapsResponse).sitemap ?? [];
    if (sitemaps.length === 0) {
      return asResult(
        `No sitemaps are submitted for ${site}. That is not itself a problem for a small site, but Google is finding its pages some other way.`,
      );
    }
    return asResult(
      [
        `${sitemaps.length} ${sitemaps.length === 1 ? "sitemap" : "sitemaps"} submitted for ${site}:`,
        ...sitemaps.map(sitemapInWords),
      ].join("\n"),
    );
  }

  return failure(
    `${toolName} is not a tool Search Console implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
