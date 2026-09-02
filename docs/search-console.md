# Search Console

The Search Console connector gives a Bot the numbers behind this deployment's own sites in Google
Search: which queries bring people in, whether a page is indexed, and what Google has done with the
submitted sitemaps. "Which pages lost traffic this month" is a Search Console question, and so is
"why isn't the pricing page showing up".

The properties belong to the deployment. They are not the properties of whoever is asking, and no
person connects an account to it. That is the difference from Google Drive, where each person
consents for themselves and sees only their own; here everybody granted the tools reads the same
numbers. Decide that before granting it, because it is the whole of the access model.

**Every tool is a read.** The connector asks Google for the read-only scope, the catalogue entry names
no write tools, and there is nothing here that submits a sitemap, requests indexing, or changes a
setting. Granting the whole connector grants the ability to look.

## The prerequisite

Three things, and all of them are an administrator's:

1. **A service account with access to each property**, granted in Search Console itself (below).
2. **Configuration**, which says which properties this deployment's Bots may ask about (below).
3. **Grants**, which say which Bots may use it. Search Console is a catalogue entry like any other, at
   `/admin/plugins/search-console`, and enabling the entry hands no Bot anything. Each of the four
   tools is granted per Bot.

### The service account

Search Console does not issue an API key, and it does not want a person's OAuth grant for this job. It
wants a service account that somebody has added as a user of each property:

1. In Google Cloud, create a project (or use one you have), enable the **Google Search Console API**,
   create a **service account**, and download a **JSON key** for it.
2. Copy the service account's email, which looks like
   `something@your-project.iam.gserviceaccount.com`.
3. In Search Console, open each property, go to **Settings → Users and permissions**, and add that
   email. **Full** is enough for everything here; **Restricted** is enough for search analytics but
   not for URL inspection.

A property the service account has not been added to is refused by Google with a permission error,
and `list_sites` is the tool that tells you which of the configured ones are actually reachable.

### The key is not an environment variable

It is the only secret in this feature, so it lives where this deployment's other secrets live: the
encrypted credential vault. Store **one credential** at `/admin/credentials` as:

- **kind** `mcp`, the vault's name for "the one token this deployment holds for this server", which is
  exactly what a service-account key is here: one secret, the deployment's, used for every Bot granted
  the tools, never anybody's own grant.
- **provider** `search-console`
- **key id** `service-account`
- **value** the whole JSON key file, pasted as it was downloaded.

One credential, not one per property, which is where this differs from the Mailbox. A mailbox password
unlocks one mailbox; a service account is verified for however many properties somebody added it to.
Which of them a Bot may ask about is `SEARCH_CONSOLE_SITES`, not the vault.

Rotate in the same place. The key is read from the vault at the moment a call needs it and thrown away
after, so a rotation takes effect on the next tool call rather than on the next restart, and revoking
it stops the tools within a call.

The access token minted from the key is held in memory for the hour Google issues it for, keyed by the
credential's own row id — so a rotation is a new id, the remembered token no longer matches, and the
next call mints from the key that is actually stored. Neither the key nor the token appears in a
result, a transcript or an audit row: every answer this connector gives, including the ones built out
of Google's own refusals, is scrubbed of both first.

## Configuration

| Variable               | Default | What it is                                                                  |
| ---------------------- | ------- | --------------------------------------------------------------------------- |
| `SEARCH_CONSOLE_SITES` | unset   | Comma-separated Search Console properties this deployment's Bots may ask about. |

Leave it unset and the connector is still listed, still grantable, and every tool call answers with the
sentence naming what to set.

A property is written exactly as Search Console spells it, and there are two spellings:

- `sc-domain:example.com` — a **domain property**, covering every scheme and every subdomain.
- `https://example.com/` — a **URL-prefix property**, covering only that prefix.

They are different properties and are not interchangeable. `example.com` on its own is neither, and an
entry that is neither refuses to start, naming it, rather than becoming a site a model can name and
Google answers with a permission failure.

```
SEARCH_CONSOLE_SITES=sc-domain:example.com,https://shop.example.com/
```

### The list is the boundary

This is the part worth reading twice. The connector never asks Google which properties the service
account can see, and never offers one that is not configured.

A service account accumulates properties. Somebody adds it to a second site to fix something and never
removes it, and from that moment a connector that trusted Google's answer would let every Bot ask about
a site nobody decided they could. So a `site` that is not in `SEARCH_CONSOLE_SITES` is refused **before
the credential is decrypted, before a token is minted and before any request is made**, and the refusal
names the properties that are configured.

The tolerance that does exist is only about spelling: case is folded and a missing trailing slash is
forgiven, because everybody types `https://shop.example.com` for a property Search Console calls
`https://shop.example.com/`. What is sent to Google is always the configured spelling, never the
caller's.

**Grants are per tool, not per property.** A Bot granted `search_analytics` can ask about every
configured property. If a property must stay out of a Bot's reach, do not configure it on this
deployment.

## The four tools

- **`list_sites`**: the configured properties, each with the access level Google reports for it. The
  place to start when the exact property string is not already known, and the place a missing
  permission shows up — a property the service account has lost access to is reported as itself rather
  than failing the whole call.

- **`search_analytics`**: clicks, impressions, click-through rate and average position, broken down by
  whichever dimensions were asked for, as a table with a totals line.

  - `dimensions` decides what each row is: `["query"]` (the default) is one row per search term,
    `["page"]` one per URL, `["date"]` one per day, `["query", "page"]` one per pair. The dimensions
    are `query`, `page`, `country`, `device`, `date` and `searchAppearance`.
  - `start_date` and `end_date` are `YYYY-MM-DD`. **The default window is the 28 days ending three days
    ago**, and that end is deliberate: Search Console's data lags a couple of days, so a window ending
    today shows a fall in traffic that did not happen. Naming one end and not the other works: an end
    date on its own means the 28 days before it.
  - `filters` is a list of `{dimension, operator, expression}`, all of which have to hold at once. The
    operators are `equals` (the default), `contains`, `notContains`, `includingRegex` and
    `excludingRegex`.
  - `search_type` is `web` (the default), `image`, `video`, `news`, `discover` or `googleNews`.
  - `row_limit` defaults to 50 and is capped at 250; `start_row` reads past the first page. Rows come
    back sorted by clicks.

  The request asks for finalised data only, so the days Google is still counting never enter a
  comparison. The totals line is explicitly about the rows shown, because the API never says how long
  the full list was, and the average position is weighted by impressions rather than averaged flat —
  which is the standard way this metric gets misreported.

- **`inspect_url`**: what Google knows about one URL — verdict, coverage state, indexing state, last
  crawl, robots.txt state, page fetch state, the canonical Google chose against the one the page
  declares, mobile usability, rich results, and a link into Search Console. The two canonicals are
  reported together, and their differing is called out, because that is the most commonly misread real
  cause of a page that is crawled and not indexed.

  **Quota: 2000 inspections per property per day**, and it is Google's, shared with anybody else using
  it. The tool description says so, so a Bot inspects the URLs a question is about rather than sweeping
  a site.

- **`list_sitemaps`**: the submitted sitemaps, with when each was last submitted and last downloaded,
  whether Google is still processing it, its error and warning counts, and per content type how many
  URLs it declares against how many Google indexed. A sitemap Google has never downloaded is said in
  words rather than left as a blank field, because that absence is usually the whole answer.

**Every result is bounded.** A row limit caps the table, the whole result is capped again at the same
20,000 characters every other connector's is, and truncation is always visible.

**Every call has a deadline.** Thirty seconds per request; a slower one is reported as Google not
answering in time rather than held open.

**Google's own sentence survives a refusal.** A 403 that names the API that is not enabled, or the
property the account cannot see, is the difference between a fix and a guess, so the status and
Google's message come back — and nothing else from the response body does.

## Governance

Nothing about a Search Console tool call is special. It goes through `plugins/store.ts` like every
other connector: the Bot's grant is checked, the policy is evaluated with the tool's effect (all four
are reads), an audit row is written, and only then is anything requested. There is no second path and
no bypass.

The audit row records the call as reached **as the deployment**, not as the person who asked. The
actor is on the row either way; what that field settles is that the access was the deployment's
service account rather than anybody's own.

## See also

- [Configuration](configuration.md): every environment variable, in one table.
- [Architecture](architecture.md): where a plugin call is decided, recorded and made.
- [Mailbox](mailbox.md): the other first-party connector that holds a credential of the deployment's
  own, and the one to read next for how that access model is meant to be granted.
- [Routines](routines.md): the first-party connector that runs in-process as the asker, and the way to
  have a Bot check these numbers on a schedule.
