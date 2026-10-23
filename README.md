# brightspace-mcp

A general, single-user MCP server for D2L Brightspace on Linux and Node.js 24 or 26. A dedicated Playwright profile supplies the session; course operations use HTTP APIs. Codex discovers contracts and composes requests. There are no course-specific teaching policies, UI automation tools, or production changes during installation.

The implementation follows [DESIGN.md](DESIGN.md). Its catalog describes known contracts; it does not limit generic access to the configured API boundary.

The primary command is `brightspace-mcp`; `d2l-mcp` remains an alias. Configuration and state retain their existing `d2l-mcp` paths so saved sessions keep working. The `D2L_MCP_CONFIG` and `D2L_ACCESS_TOKEN` environment variables, `d2l` Codex connection key, and `d2l_*` tool names also remain compatible.

## Install and authenticate

Use Node.js 24 or 26 and `flock` from Linux `util-linux`, then:

```sh
node --version  # v24.x or v26.x; an existing Node 26 installation is supported
npm ci
npx playwright install --with-deps chromium
npm run build
node dist/cli.js init --origin https://your-brightspace-tenant.edu
node dist/cli.js login
node dist/cli.js status
```

Installing Chromium system dependencies may require your system package manager's privileges. `login` needs an interactive terminal and graphical display. Complete SSO/MFA yourself in the dedicated browser, then press Enter in the terminal. The command verifies the account using `users/whoami`; it never fills sign-in forms. A headless server reuses that profile and a private snapshot of session cookies.

Browser discovery prefers `auth.executablePath` when configured, then Playwright's installed Chromium, then `/usr/bin/chromium` or `/usr/bin/chromium-browser`. All choices use the dedicated profile. On Arch Linux with system Chromium installed, the Playwright browser download is optional. To pin that browser, add `"executablePath": "/usr/bin/chromium"` inside `auth`. Startup errors identify missing executables, profile conflicts, display access, missing libraries, or process restrictions without exposing raw browser logs. System browser versions can change independently of Playwright; if compatibility changes, use Playwright's matching Chromium or a verified explicit executable.

Node 24 is the LTS baseline recorded in `.nvmrc`; Node 26 is also supported and has passed the same unit, Chromium, and stdio checks. An existing Node 26 installation needs no downgrade. The LTS baseline follows the design's deployment preference, not a technical dependency on Node 24. See the [Node.js release status](https://nodejs.org/en/about/previous-releases).

If `whoami` needs a different supported LP version, set `auth.whoamiVersion` in the config. A successful identity check verifies that account on that tenant, not permission to every API or support for every mutation.

Browser-session requests use an observed `XSRF.Token` local-storage value with `X-Csrf-Token` by default. This is grounded in [D2L's support discussion](https://community.d2l.com/brightspace/discussion/2359/authorization-tokens-that-keep-expiring), not a universal third-party support guarantee. If the tenant uses a cookie, configure `auth.csrfCookieName`. If it provides a verified programmatic token API, configure its path, JSON pointer, and evidence:

```json
{
  "csrfTokenEndpoint": {
    "path": "/an-established-api/token-route",
    "pointer": "/Token",
    "source": "Your verified tenant documentation or captured application request"
  }
}
```

This object goes inside `auth`. The route must already be within the configured API boundary; no token endpoint is guessed or probed. Writes without observed/configured CSRF material fail before transmission. An ordinary 403 is reported separately from an explicit CSRF rejection and includes a reminder to verify the authentication mechanism.

When observed, the session CSRF token accompanies reads too, including the identity check. Login saves session cookies before reading the tenant's configured authentication storage value; it does not export storage from every SSO origin. Optional token-observation failures do not discard saved cookies. Keep the browser open until the terminal has captured authentication. If capture fails, the error identifies its phase and safe runtime code instead of exposing raw browser logs or credentials.

For a registered/token provider, replace `auth` with:

```json
{ "provider": "bearer", "tokenEnv": "D2L_ACCESS_TOKEN", "whoamiVersion": "1.49" }
```

Supply the access token in that environment variable. Your external registered client manages OAuth issuance and renewal. This server does not embed OAuth registration, a token-refresh service, or sign-in form automation. Browser access does not require registering an OAuth client.

## Connect Codex

Launch a Codex session with D2L explicitly enabled:

```sh
npm run codex
```

This repository's launcher uses [single-run Codex configuration overrides](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli). It starts Codex in this repository and enables the built server only for that invocation. It writes no global or project Codex registration. Ordinary `codex` sessions, including other chats in this directory, do not gain D2L automatically. The server exits when its owning client closes; there is no background service.

Confirm the opt-in configuration without starting a chat:

```sh
npm run codex -- mcp get d2l
```

Inside the new session, use `/mcp` to inspect the connection, then ask Codex to call `d2l_session_status`. Additional CLI arguments can be passed after `--`, for example `npm run codex -- resume`. To select a different server config, set `D2L_MCP_CONFIG` before launching. The launcher forwards that variable and the default bearer provider's `D2L_ACCESS_TOKEN` when present. Client approval policy remains unchanged; `d2l_api_write` accurately advertises mutation effects and does not impose a second confirmation loop.

Only **one process owns a state directory/profile**. The server, `login`, and CLI `status` share a kernel `flock`, including during startup. While Codex owns it, use `d2l_session_status` through MCP. Stop that MCP process before running `login` or CLI `status`. Multiple simultaneous stdio clients are intentionally unsupported; use separate state directories for separate sessions. The lock is released on normal shutdown or pipe/process termination. Never delete `owner.lock` while an owner is running. If Chromium was orphaned by a forced kill, stop that dedicated Chromium process before restarting; never remove a live browser's singleton lock.

On an API authentication challenge or an explicit CSRF rejection during the identity check, the browser provider first tries one background refresh: it loads the configured tenant `auth.loginPath` (normally `/`) in the dedicated headless profile, allows ordinary redirects/scripts to reuse existing SSO, captures cookies and the configured CSRF slot, and verifies the identity API again. Page navigation is limited to `timeoutMs` (at most 30 seconds); the temporary page is then closed. It never fills forms, clicks sign-in controls, or reads course content. A successful refresh is saved for the next process. A failed refresh is not repeated until authentication succeeds or the process restarts. An expired read can retry once after account verification; writes are never replayed automatically.

If interactive sign-in is still needed, session status returns `manualLoginRequired: true`. Stop the owning MCP process, run `login`, restart it, and check session status. Ordinary API permission errors do not trigger browser renewal. Login HTML is discarded; the server never returns it as course data. Each session check returns a `requestId` and `sessionRecovery` report; inspect its sanitized initial error, navigation mode/outcome, and final verification using `d2l_get_request_status` or `node dist/cli.js diagnostics REQUEST_ID`. These records use the normal private storage and retention settings.

If D2L tools are absent from a Codex turn, a plugin-catalog search cannot discover this locally configured MCP server. Check the opt-in launcher/session configuration above. Local execution errors are separate from D2L authentication: `LOCAL_PERMISSION_DENIED` identifies denied filesystem/process access; `LOCAL_IO_ERROR` includes the system code and stage (for example `EROFS` at `prepare-private-directory` when a runner mounts the state directory read-only); unexpected failures use `INTERNAL_ERROR`. Run with authorized state-directory write access and browser subprocess support. Repeating login does not fix those restrictions. `SERVER_FEATURE_MISSING` is reserved for identified implementation/dependency gaps.

This is local stdio, not a remotely reachable service. A hosted client needs a separately implemented, explicitly authenticated transport. The server exposes no HTTP MCP listener.

## Tools

| Tool | Use |
| --- | --- |
| `d2l_session_status` | Verify tenant/account identity and authentication state. |
| `d2l_api_versions` | Discover supported API families and versions; `refresh` bypasses the daily in-memory cache. |
| `d2l_search_operations` | Search descriptions, resources, parameters, or read/write semantics. |
| `d2l_describe_operation` | Inspect contracts, schema gaps, sources, permissions, coverage, and version bounds. |
| `d2l_refresh_catalog` | Reload local declarative extensions. |
| `d2l_api_read` | Invoke a catalog read or an explicit relative API request. |
| `d2l_api_write` | Preview/apply a mutation with optional preconditions, compatibility handling, and verification. |
| `d2l_api_paginate` | Collect established pages with explicit limits and expiring continuations. |
| `d2l_get_request_status` | Inspect a technical audit; optionally reconcile by reading current state. |
| `d2l_get_result` | Retrieve bounded slices/chunks of a private export. |

The official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) handles stdio, schemas, and tool registration. Protocol messages use stdout; diagnostics use stderr.

## Compose API calls

Discover an operation, inspect its contract, and retrieve data:

```json
{ "query": "enrollments", "semantics": "read" }
```

Pass that to `d2l_search_operations`, then describe `enrollments.mine`. To `d2l_api_paginate`:

```json
{
  "request": { "operationId": "enrollments.mine" },
  "maxPages": 10,
  "maxItems": 10000,
  "exportOnly": true
}
```

Continue with `{ "continuation": "RETURNED_HANDLE" }`. A completed traversal covers this endpoint and these filters; it does not prove full role visibility. Enrollment permissions can suppress users and even produce empty sets, as described by [D2L](https://docs.valence.desire2learn.com/res/enroll.html). Resolve academic terms from course/org-unit relationships in client code; availability dates and active flags do not establish term membership.

`d2l_api_read` accepts a catalog operation:

```json
{
  "operationId": "news.list",
  "pathParams": { "orgUnitId": "12345" },
  "query": { "since": "2026-01-01T00:00:00.000Z" }
}
```

It also accepts a documented API absent from the catalog:

```json
{
  "method": "GET",
  "path": "/d2l/api/lp/1.49/courses/schema",
  "pagination": { "kind": "none", "itemsPointer": "" }
}
```

An explicit path contains its own version and cannot use `pathParams` or `version`. A catalog ID cannot have its route or method overridden. The catalog selects the highest advertised version **inside its bounded contract range**, comparing numeric components correctly. Explicit newer/unknown contracts still work with transport-only validation. An unusual read method, such as `versions.check`'s POST, needs established catalog semantics to use the read tool.

`npm run demo` runs a complete SDK client composition against an in-memory fixture, with no credentials or network. It collects enrollments, varies announcement query parameters, and invokes `courses.schema` from an extension without adding a tool. To change parameters:

```sh
npm run demo -- --course 456 --since 2026-09-01T00:00:00.000Z
```

After authentication, `npm run demo -- --config /absolute/path/config.json --course ACTUAL_ID` explicitly runs the same **reads** through a real stdio process. It assumes LP 1.49 for its explicit course-schema example; inspect versions and permissions first. A fixture run is evidence of composition, not tenant support.

Analyses, grade formulas, section joins, missing/exempt-value handling, quiz mappings, workflow persistence, and scheduling belong in client-side code using these same tools. No example teaching policy is installed by the server.

## Mutations and verification

Supply a reviewed write-model body. Do not assume a GET response is a valid replacement payload. Example `d2l_api_write` structure (identifiers and the complete contract body must come from your actual request):

```json
{
  "request": {
    "operationId": "news.update",
    "pathParams": { "orgUnitId": "12345", "newsItemId": "67" },
    "body": { "YOUR_COMPLETE_REVIEWED_NEWS_ITEM_DATA": true },
    "headers": { "If-Match": "\"etag-if-supported-by-this-endpoint\"" }
  },
  "preview": true,
  "before": {
    "request": { "operationId": "news.get", "pathParams": { "orgUnitId": "12345", "newsItemId": "67" } },
    "checks": [{ "pointer": "/Title", "equals": "Old title" }]
  },
  "verification": {
    "request": { "operationId": "news.get", "pathParams": { "orgUnitId": "12345", "newsItemId": "67" } },
    "checks": [{ "pointer": "/Title", "equals": "Intended title" }]
  }
}
```

This is an envelope illustration, not a valid NewsItemData payload. `preview: true` performs validation and optional before-reads but sends no mutation. Set it to `false` only for an authorized operation with a valid body. Preview status records exclude a pending-write assertion.

Checks use JSON pointers, exact JSON equality, and optional `exists`; a top-level `sha256` can compare the entire normalized JSON read model. A before-check is advisory against other clients unless the API implements your supplied conditional header. The server serializes its own request sequences; it cannot guarantee isolation across external actors. Replacement operations warn that omissions may reset unrelated fields. There is no universal merge/rollback algorithm.

Writes have distinct technical outcomes: accepted but unverified, observed without an assertion, verified for listed assertions, mismatch, verification failure, or uncertain outcome. A 2xx does not prove a teaching goal was achieved. A timeout/connection loss or uncertain server response never triggers a write replay. Use its request ID with `d2l_get_request_status` and a `reconcile` read/check specification. Matching current state does not prove which request caused it. CLI `diagnostics REQUEST_ID` reads the private audit even while the server runs.

Caller-authorized compatibility rules can be supplied alongside a mandatory verification read:

```json
{
  "pointer": "/NumberOfAttemptsAllowed",
  "rejectionPattern": "NumberOfAttemptsAllowed",
  "omit": true,
  "defaultValue": 1,
  "allowNullTransition": false,
  "source": "https://docs.valence.desire2learn.com/res/quiz.html"
}
```

This is one element of `compatibility`. The server first sends the original body, then tries omission only after a matching definitive 400/422 response, and then an explicitly permitted default if omission also receives that attributed rejection. `rejectionPattern` is a case-insensitive literal substring, not a regular expression. The rule must identify the actual field rejection. Alternatives never run after permission/authentication/rate-limit/conflict/network failures. Only one attributed field sequence is adjusted per write; use subsequent explicit requests for other corrections. Exact `bodyJson` requests do not use compatibility rewriting.

Omission can alter a field and is never reported as preservation. Read-back reports actual differences. Null/finite default transitions require `allowNullTransition: true`; the server does not equate null, missing, and zero. The quiz schema is intentionally structural so callers can first try preserving a legacy zero. It does **not** claim that zero is accepted by the documented write contract. There is no automatic full quiz serializer because rich-text and protected values need complete read/write knowledge.

## Extend and refresh contracts

`catalog/builtin.json` is versioned metadata backed by source references. Add JSON files to `catalogFiles` in the config; paths resolve relative to that config. [examples/catalog-extension.json](examples/catalog-extension.json) is a working documented extension. Run `node dist/cli.js catalog-check`, then `d2l_refresh_catalog` or restart. Later files intentionally override an operation by ID. Refresh means reloading reviewed local metadata, not silently scraping a changing reference site.

Each operation declares ID, description, method/path, read/write semantics, source/support status, bounded versions when versioned, schema knowledge, and optional JSON Schemas, permissions, update behavior, and pagination. See `src/catalog.ts` for the validated metadata format. Contract knowledge, generic implementation coverage, and live tenant validation are returned separately. No bundled endpoint is represented as live-tenant validated.

Pagination is declarative: `none`, a bookmark contract with explicit pointers and query parameter, or a next-URL contract with explicit item/link pointers. Bookmark/next-URL contracts require a source; caller-supplied explicit contracts can use these same forms. Completion requires the stated markers. Nested paged collections remain separate collections. `sections.list` and `sections.paged` retain their different coverage and are never substituted for each other.

A reusable `field-map` serializer can be declared in an extension:

```json
{
  "kind": "field-map",
  "fields": [
    { "from": "/ReadName", "to": "/Name", "required": true },
    { "from": "/Nested/Enabled", "to": "/IsEnabled", "required": true }
  ]
}
```

Place it in the operation's `serializer` field, then pass the read model as `sourceBody` instead of `body`. Output pointers currently target properties of existing objects (normally top-level write fields). Missing required or redacted values are rejected. Only declared fields are translated; this does not promise preservation of undeclared properties. A new contract needing richer translation requires a reusable serializer extension, not a task-specific handler.

Verified first-party endpoints need evidence such as tenant documentation or an existing application request trace. Mark their support `verified-first-party`. New route families or API origins additionally require an `apiRoutes` entry with exact origin, path prefixes, and source. Catalog metadata alone does not expand credential routing. These are trusted local configuration, not caller-provided tools. Identity-provider routes must remain outside ordinary API invocation.

## Data, transport, and retention

Configuration defaults to `$XDG_CONFIG_HOME/d2l-mcp/config.json` or `~/.config/d2l-mcp/config.json`. State defaults to `$XDG_STATE_HOME/d2l-mcp` or `~/.local/state/d2l-mcp`. See [config.example.json](config.example.json). `stateDir` and `catalogFiles` may be absolute or config-relative. An HTTPS tenant origin is required; `allowHttpLocalhost` exists only for local fixtures.

State directories use mode 0700 and server-written files 0600. The dedicated profile, session-cookie snapshot, and CSRF cache contain credentials. They remain private until sign-out/expiry or explicit deletion of that dedicated state. Course result files, snapshots, continuations, and audits expire after `retentionHours` (24 by default). Expired records become unreadable immediately and are deleted at startup, explicit cleanup, or subsequent writes (at most once a minute). There is no background cleanup daemon while the service is stopped. All private state should stay outside source control.

Results above `inlineBytes` (48,000 by default) become expiring handles plus private local JSON paths. Local exports are wrapped as `value.data`. `d2l_get_result` returns array slices or bounded `json-text` chunks of an object/string; follow `nextOffset` and concatenate chunks before parsing. A single oversized array item requires reading the provided local file. Continue pagination as well as downloading exports: one exported segment does not imply collection completeness.

Responses preserve unknown fields, absent properties, null, zero, and false. Unsafe JSON numbers become exact decimal strings to avoid rounding; `numericRepresentations` records their source number type, JSON pointer, and original numeric spelling (per page for a collection). Pass IDs as strings. `bodyJson` sends exact validated JSON text for contracts requiring numeric IDs beyond JavaScript precision. Unsafe integer values in normal tool arguments are rejected. Request JSON Schemas are checked without coercion, defaults, or field removal; an unknown schema is explicitly transport-only. Raw scores and units remain available for client analysis.

Supported transfers: JSON request bodies; JSON, text, or binary responses. Use `responseType: "text"` or `"binary"` explicitly. Binary responses become private base64 exports. Multipart uploads, resumable uploads, streaming/range downloads, and arbitrary request header extensions are not implemented and require general transport work. The browser provider currently buffers a response before enforcing `maxResponseBytes` (20 MB by default); use endpoint pagination for large collections.

Only allowed content-negotiation and conditional headers can be supplied. Cookies, authorization, CSRF, Host, Origin, and authentication query parameters are server-managed. URLs are tenant-relative, canonicalized before use, and restricted to established API prefixes/origins. Redirects are inspected before forwarding credentials; only same-origin GET/HEAD API redirects are followed. Writes and unusual read-method redirects are never replayed. GET errors and rate limits use bounded retries honoring `Retry-After`; writes have no automatic transport retry.

Internal API responses remain intact for version selection, pagination, schema validation, and state checks. Public reports, MCP output, exports, and audits redact observed credentials and sensitive fields, including quiz passwords and values in verification evidence. Cookie substring filtering is limited to credential-named or HttpOnly cookies with values of at least 12 characters; short values are protected in sensitive fields and authentication headers rather than replaced throughout ordinary data. Ordinary preferences are not registered merely because they are cookies. The server does not turn redacted values into empty replacement fields. Private audit snapshots can still contain student data; retention and filesystem permissions apply. Low-level transport results and errors contain original API data and must pass through the redactor before logging or presentation.

## Verify and inspect

```sh
npm run check
npm test
npm run test:integration
npm run demo
```

Unit tests use fixtures and the official SDK's in-memory transport. Integration tests run real Chromium and a real stdio process against a temporary localhost HTTP fixture; they require installed Chromium and permission for loopback sockets/child processes. To test a system Chromium instead of Playwright's download:

```sh
D2L_TEST_CHROMIUM=/usr/bin/chromium npm run test:integration
```

Tests cover session reuse/expiry, CSRF, profile ownership, path/origin/header restrictions, credential-safe redirects, catalog extension, versions, multiple API families, pagination/exports, precision/value preservation, preconditions, compatibility adjustments, verification, uncertain outcomes, and error classification. No live tenant test or production write is claimed. Tenant authentication, permissions, undocumented first-party contracts, and serializer compatibility still require API-based tenant verification.

Sources were checked during implementation on 2026-10-22. The principal references are linked in each catalog entry and [DESIGN.md](DESIGN.md). Recheck the relevant reference before broadening version bounds or adding a serializer.
