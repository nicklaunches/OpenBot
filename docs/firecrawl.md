# Firecrawl

A Bot with this connector granted reads public web pages through the deployment's own Firecrawl
instance: a page comes back as markdown with the links on it, rendered the way a browser would render
it. It is the way a Bot reads the web from a turn that has no browser, which is every routine, and the
cheaper way when reading is all that is needed.

The instance is the deployment's, not a vendor's. Firecrawl is open source; whoever runs OpenBot runs
a copy on an address of their choosing, usually behind a certificate signed by a private CA. OpenBot
reaches it with one API key, held by the deployment and spent by every Bot granted the tools. There is
no per-person half: two Bots reading the same page read the same page.

## The prerequisite

A running Firecrawl instance this server can reach over HTTPS, and its API key.

### The key is not an environment variable

The key is the only secret in this feature, so it lives where the deployment's other secrets live:
the encrypted credential vault. Store it at `/admin/credentials` with these three values, exactly:

| Field    | Value       |
| -------- | ----------- |
| kind     | `mcp`       |
| provider | `firecrawl` |
| key id   | `api-key`   |

The connector resolves it from the vault on every call. Rotate it there and the next call uses the new
key; revoke it there and the next call refuses. Nothing is read at start-up and nothing is cached.

## Configuration

| Variable             | Meaning                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FIRECRAWL_BASE_URL` | The instance's origin, scheme and port included: `https://firecrawl.internal:3002`. Only the origin is kept; a path after it is dropped. |
| `FIRECRAWL_CA_FILE`  | Path to the PEM of the certificate authority that signed the instance's certificate. Relative paths resolve from the server's working directory. |

Leave `FIRECRAWL_BASE_URL` unset and the connector is still in the catalogue, still grantable, and
every call answers with what to set. That is deliberate: a Bot's grants are an administrator's
decision and should not evaporate because a variable was unset during a deploy.

### The CA rides with the request

A self-hosted instance on a bare address has a certificate no public trust store knows. The
alternative some reach for is to stop verifying, which would leave the key in every request open to
whatever can answer on that address. Instead, the CA named by `FIRECRAWL_CA_FILE` is read once at
start-up and attached to each request to the instance, and nothing else in the process changes what it
trusts. A file that cannot be read refuses to start, naming the variable, rather than falling back to
the public store and failing every call at the wrong end.

The repository ships `certs/firecrawl-ca.crt` for the instance nicklaunches.com uses; a deployment
with its own instance points the variable at its own CA.

## The three tools

Every tool takes a `url`, and every `url` is checked before anything else happens: it has to be a web
address on a public host. An address on a private network, at `localhost`, or at a cloud metadata
endpoint is refused before the key is read, by the same rule the Bot's own browser applies to a
navigation. The instance fetches from wherever it runs, and what it can reach on its own network is
not a thing a model gets to name.

| Tool            | Reads                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrape`        | One page as markdown, with its title, description and links. `only_main_content` (default true) strips navigation and footers; `max_chars` (default 12 000) bounds the text and the answer says when it was cut.                          |
| `map_site`      | The addresses a site has, ranked by an optional `search` term such as `contact` or `pricing`. Up to 200. The right first call on an unfamiliar site, because it reads link structure rather than pages.                                    |
| `find_contacts` | A composite: reads the home page, follows the about, team, contact and pricing pages it finds, up to `max_pages` (default 4), and returns emails, X, LinkedIn and GitHub profiles, contact forms and the pricing page as JSON. One call per product. |

Every answer is capped at the same visible limit the vendor transports use, and every answer and
every failure is scrubbed of the key before a model reads it.

## Governance

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot at
`/admin/plugins/firecrawl`, exactly as a Google Drive or Notion tool would be. Every call then checks
the grant, evaluates the action policy, and writes an audit row recording that the access was the
deployment's rather than the asker's. All three tools classify as reads; a policy that wants to bound
where a Bot may read from does so on the tool's name, since rules see a call's name and effect rather
than its arguments.

## See also

- [Architecture](architecture.md): where plugins, grants, policy and audit sit.
- [Configuration](configuration.md): `FIRECRAWL_BASE_URL`, `FIRECRAWL_CA_FILE`.
- [Routines](routines.md): the headless turn this connector was built for.
- [Firecrawl's self-hosting guide](https://docs.firecrawl.dev/contributing/self-host).
