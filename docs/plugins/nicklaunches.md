# Nick Launches

A Bot with this connector granted reaches the MCP server nicklaunches.com runs at
`https://nicklaunches.com/api/mcp/`, over the catalogue's default MCP transport. The reading tools
answer anybody, so the entry needs no credential: an administrator adds it, presses **Refresh tools**,
and grants what each Bot may call.

## The tools

| Tool                      | Effect | What it does                                                                                                                                         |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_products`         | read   | Search what has launched, by name, tagline or description. Cursor-paged.                                                                             |
| `get_product`             | read   | One launched product's full public listing, by slug.                                                                                                 |
| `list_launch_directories` | read   | The launch directories nicklaunches.com has vetted, with domain rating, link type and what submitting involves.                                      |
| `check_launch_readiness`  | read   | Audit a product site before submitting: badge present, already listed or in relaunch cooldown, metadata complete. Rate limited to ten an hour per caller. |
| `get_my_launches`         | read   | The launches of the connected account. Needs a paired account.                                                                                       |
| `submit_product`          | write  | Open a launch draft from a URL. Creates a draft only; a person reviews it. Needs a paired account.                                                   |
| `connect_account`         | write  | Pair the session with a person's account through a one-time approval link.                                                                          |

The two write tools are named in the catalogue so the action policy sees them. A deployment that wants
a Bot to open drafts grants them deliberately; the pairing they need is a session on the vendor's side,
approved by a person in a browser, not a credential this deployment holds.

## Two rate limits worth knowing

- The server rate limits `initialize` to sixty an hour per IP address, and OpenBot opens a fresh MCP
  session for every tool call. Sixty tool calls an hour, across every Bot on the same outbound
  address, is the budget.
- `check_launch_readiness` crawls the site it is asked about and allows ten an hour per caller. Use
  `search_products` for the cheap question of whether a product is listed, and reserve the readiness
  check for the few that matter.

## What an administrator does

1. At `/admin/plugins/nicklaunches`, press **Add**. No token is asked for.
2. Press **Refresh tools**. The seven tools above are recorded.
3. Grant tools per Bot, as for any connector.

## See also

- [Architecture](../architecture.md): where plugins, grants, policy and audit sit.
- [nicklaunches.com's API page](https://nicklaunches.com/api-mcp/), which documents the same server
  for any MCP client.
