import { JWT } from "google-auth-library";

/**
 * The only place in this deployment that talks to Google Search Console.
 *
 * One door, for the reason `plugins/mcp.ts` and `mailbox/client.ts` are each one door: every call out
 * carries a credential and brings back text a model will read, so both directions want a single place
 * to be careful in. A second client somewhere else would be a second place to forget the deadline,
 * the error handling, or the rule that neither the private key nor the access token ever appears in
 * anything anybody reads.
 *
 * WHAT THIS MODULE IS NOT. It makes no decision about whether a call is allowed, which property may
 * be asked about, or what a model should be told. It mints a token, speaks HTTP and hands back plain
 * values. `plugins/builtin-search-console.ts` holds the tools, the site allowlist, the argument
 * checking and the sentences; the split is the same one Mailbox has between `mailbox/client.ts` and
 * `plugins/builtin-mailbox.ts`.
 *
 * TWO HOSTS, ONE CONNECTOR. The old Webmasters API serves sites, search analytics and sitemaps; URL
 * inspection was added later on its own host and has never been backported. They are pinned as
 * separate constants rather than assembled from a base, so a reader can see that a request goes to
 * exactly one of two reviewed addresses and to nothing a caller supplied.
 */

/** The v3 Webmasters API: sites, search analytics and sitemaps. */
export const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";

/** The Search Console v1 API, which is where URL inspection lives and only URL inspection. */
export const INSPECTION_BASE = "https://searchconsole.googleapis.com/v1";

/**
 * The one scope this connector asks for.
 *
 * Read-only, because every tool here is a read and there is no write to grant. The writing scope
 * (`webmasters`) would let a token submit and delete sitemaps, which is a thing nobody asked this
 * connector to be able to do, so it is not requested rather than requested and declined.
 */
export const READONLY_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

/**
 * How long Google gets before we give up on it.
 *
 * The same thirty seconds the mail client allows, and for the same reason: a request that has said
 * nothing for half a minute is a turn that is hanging with somebody waiting at the end of it. Search
 * analytics over a long window with several dimensions is the slow case and is comfortably inside it.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

export class SearchConsoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchConsoleError";
  }
}

/**
 * An access token and the moment it stops being one.
 *
 * `expiresAt` is epoch milliseconds rather than a lifetime, because the only question anybody asks of
 * it is "is this still good", and a duration has to be combined with the time it was issued to answer
 * that. Google's own token response carries the absolute form, so nothing is computed here that could
 * drift.
 */
export type MintedToken = {
  token: string;
  expiresAt: number;
};

/**
 * The parts of a service-account JSON this connector uses, and the two it insists on.
 *
 * Everything else Google puts in the file — the project id, the key id, the token URI, the certificate
 * URLs — is either constant or unused here, so it is not modelled. What is modelled is checked,
 * because a file that is missing the email or the key is a file that produces an authentication
 * failure from Google at run time, in front of somebody, about a credential an administrator believes
 * they stored correctly.
 */
type ServiceAccount = {
  client_email: string;
  private_key: string;
};

/**
 * The service-account JSON, read as one.
 *
 * NOTHING FROM THE PARSER'S OWN MESSAGE IS SURFACED. `JSON.parse` quotes the input it choked on, and
 * the input here is a file containing a private key, so its complaint is one of the few strings in
 * this process that must never be passed along. The sentence says what was wrong and what to store
 * instead, which is all an administrator needs and is the half that is safe to say.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SearchConsoleError(
      "The stored Search Console credential is not valid JSON. It has to be the whole service-account key file, as downloaded from Google Cloud.",
    );
  }

  const account = parsed as Partial<ServiceAccount> | null;
  const email =
    typeof account?.client_email === "string" ? account.client_email : "";
  const key =
    typeof account?.private_key === "string" ? account.private_key : "";
  if (!email || !key) {
    throw new SearchConsoleError(
      "The stored Search Console credential is JSON but not a service-account key: it has no client_email, no private_key, or neither. Store the whole key file Google Cloud downloaded.",
    );
  }
  return { client_email: email, private_key: key };
}

/**
 * A service account, exchanged for an access token.
 *
 * Google's own library rather than a hand-rolled JWT assertion. Signing an RS256 assertion, encoding
 * it and posting it to the token endpoint is thirty lines that are wrong in ways nobody notices until
 * a clock skews or a key rotates, and this is the library Google publishes to be right about exactly
 * that.
 *
 * The token is returned rather than kept, because whose token it is and how long it should be held is
 * a question about the credential it came from — see the cache in `plugins/builtin-search-console.ts`,
 * which is keyed by credential id so a rotation cannot be answered from the old key's token.
 */
export async function mintAccessToken(raw: string): Promise<MintedToken> {
  const account = parseServiceAccount(raw);
  const client = new JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: [READONLY_SCOPE],
  });

  const credentials = await client.authorize();
  const token = credentials.access_token;
  if (!token) {
    throw new SearchConsoleError(
      "Google issued no access token for this service account. Check that the Search Console API is enabled for its project and that the key has not been disabled.",
    );
  }
  /*
   * Google's own expiry when it sent one, and an hour otherwise.
   *
   * The fallback is deliberately the shorter of the two plausible guesses. A token believed to last
   * longer than it does produces a 401 in the middle of somebody's turn; one believed to last less
   * costs an extra mint, which is a round trip nobody sees.
   */
  return {
    token,
    expiresAt: credentials.expiry_date ?? Date.now() + 3_600_000,
  };
}

/**
 * A property string as it goes into a path segment.
 *
 * Percent-encoded rather than interpolated, and this is not cosmetic: both spellings Search Console
 * uses carry characters that mean something in a URL. `sc-domain:example.com` has a colon, and
 * `https://example.com/` is a URL inside a path segment, slashes and all. Interpolated raw, the second
 * one addresses a different endpoint entirely.
 */
export const encodeSite = (site: string): string => encodeURIComponent(site);

/**
 * A sentence with this deployment's secrets taken out of it, in the spellings they can appear in.
 *
 * Belt and braces over a rule already kept: nothing here logs a token and nothing puts a key in a
 * result. What this covers is the sentence somebody ELSE wrote. A failure from the token endpoint can
 * quote the assertion back, and an HTTP client that includes request context in an error can carry
 * the `Authorization` header with it. That text goes into an audit row and in front of a model, and
 * neither is a place for a private key or a bearer token.
 *
 * THE ESCAPED FORM OF THE KEY IS NOT PARANOIA. The credential is stored as JSON, so the key inside it
 * has literal `\n` two-character sequences where the PEM has newlines. A message that quoted the
 * stored file rather than the parsed key would carry that spelling, and a redaction that only knew the
 * parsed one would pass it through while looking like it worked. The base64 body is redacted on its
 * own for the same reason: a PEM reformatted by anything in the path keeps the body and loses the
 * line breaks.
 *
 * A short secret is skipped rather than replaced everywhere, since replacing a three-character string
 * would redact half the alphabet out of an unrelated message.
 */
export function redacted(
  message: string,
  secrets: readonly (string | null | undefined)[],
): string {
  const forms: string[] = [];
  for (const secret of secrets) {
    if (!secret) continue;
    forms.push(secret);
    forms.push(secret.replaceAll("\n", "\\n"));
    // The PEM body alone: header, footer and every line break removed.
    const body = secret
      .replace(/-----[A-Z ]+-----/g, "")
      .replaceAll("\\n", "")
      .replaceAll(/\s+/g, "");
    if (body.length >= 16 && body !== secret) forms.push(body);
  }

  let scrubbed = message;
  for (const form of forms) {
    if (form.length < 8) continue;
    scrubbed = scrubbed.split(form).join("[redacted]");
  }
  return scrubbed;
}

/**
 * How a request is actually made.
 *
 * A seam rather than a direct call to the global, and it is the same seam `MailboxClients` is: the
 * properties worth asserting about this module are which URL a call went out to, what body it
 * carried, and what a model is told when Google refuses — and asserting any of that otherwise would
 * need Google, which means the properties most worth testing would be the ones never tested.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type ApiResult =
  | { ok: true; body: unknown }
  | { ok: false; message: string };

/**
 * One request to Google, with the deployment's token.
 *
 * GET when there is no body, POST when there is, because that is the whole of what the four tools
 * need and a method argument would be a third thing to get wrong.
 *
 * GOOGLE'S OWN SENTENCE IS SURFACED AND ITS BODY IS NOT. For a 403 the message names the property or
 * the API that is not enabled, which is the difference between a fix and a guess; the surrounding
 * JSON is the vendor deciding how much of a model's context to spend and can carry request echoes.
 * So the status and `error.message` come out, and nothing else does.
 */
export async function apiRequest(
  http: FetchLike,
  token: string,
  url: string,
  body?: unknown,
): Promise<ApiResult> {
  let response: Response;
  try {
    response = await http(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "Search Console did not answer in time."
          : `Search Console could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") {
        detail = parsed.error.message;
      }
    } catch {
      // Not JSON. The status alone is still worth saying, and the body is still not.
    }
    return {
      ok: false,
      message: detail
        ? `Search Console refused this request (${response.status}): ${detail}`
        : `Search Console refused this request (${response.status}).`,
    };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch {
    return {
      ok: false,
      message: `Search Console answered ${response.status} with something that is not JSON.`,
    };
  }
}

/** One property as `sites.get` describes it. */
export type SiteEntry = {
  siteUrl?: string;
  permissionLevel?: string;
};

/** One row of a search analytics answer. `keys` is one entry per requested dimension, in order. */
export type SearchAnalyticsRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

export type SearchAnalyticsResponse = {
  rows?: SearchAnalyticsRow[];
};

/** What `urlInspection/index:inspect` answers with, as much of it as this connector reads out. */
export type InspectionResponse = {
  inspectionResult?: {
    inspectionResultLink?: string;
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
      sitemap?: string[];
      crawledAs?: string;
    };
    mobileUsabilityResult?: { verdict?: string };
    richResultsResult?: { verdict?: string };
    ampResult?: { verdict?: string };
  };
};

/** One submitted sitemap as `sitemaps.list` describes it. */
export type SitemapEntry = {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: {
    type?: string;
    submitted?: string | number;
    indexed?: string | number;
  }[];
};

export type SitemapsResponse = {
  sitemap?: SitemapEntry[];
};
