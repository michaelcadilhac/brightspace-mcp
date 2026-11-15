# Brightspace MCP Server — Design and Implementation Specification

## 1. Purpose and governing principle

Build a general-purpose, single-user, instructor-facing MCP server that gives Codex authenticated programmatic access to an instructor's D2L Brightspace account. The browser supplies an authenticated session; all automated course operations use APIs. The product focus is instructor course management, configuration, and analysis, rather than student study planning or homework submission.

The server is a reusable D2L API interface. Codex interprets the user's requests, discovers relevant operations, retrieves data, performs analysis, and composes the necessary API calls. The server supplies reliable access to those operations without implementing the user's individual teaching policies as built-in features.

The comparison in `README.md` explains this project's positioning against other Brightspace MCP servers. `FUTURE.md` records candidate improvements within the instructor-facing, API-only boundary; those candidates are not assertions of implemented capability or tenant support.

**A new task using an available D2L API should not require a new task-specific MCP tool or a change to the server's business logic.** Extending a declarative API catalog or adding a reusable serializer for a newly encountered contract is different from implementing a feature for each natural-language request.

The user's examples—listing current-quarter courses, enforcing an exam threshold, calculating section averages, and Boolean quiz grading—illustrate the breadth of tasks this interface should enable. They are not an exhaustive feature list, a fixed task dispatcher, or instructions to install those policies in an account. Section 8 shows how Codex could compose the general interface for those examples.

This document is self-contained. Implement a working MCP server, authentication/session management, API discovery and invocation, focused tests, and installation documentation. Target Linux, with a configurable Brightspace origin and `America/Chicago` as the default display timezone. Do not hard-code courses, users, quiz counts, academic terms, thresholds, category weights, or grading formulas.

## 2. Division of responsibilities

| Concern | MCP server | Codex or a client-side workflow |
| --- | --- | --- |
| Authentication | Hold the session, supply cookies/tokens, detect expiry. | Ask the user to complete sign-in when needed. |
| API knowledge | Expose operation descriptions, schemas, versions, sources, and coverage. | Find and understand the operations relevant to a request. |
| Requests | Validate transport inputs, authenticate, send requests, return responses and errors. | Choose targets, parameters, intended changes, and the sequence of calls. |
| Data retrieval | Handle pagination, completeness, retrieval time, and large-result access. | Join data, select populations, resolve term/course/section meaning. |
| Analysis | Preserve values, types, units, and provenance. | Compute averages, comparisons, reports, or other derived results, using local code where appropriate. |
| Mutations | Support preconditions, contract-specific serialization, technical audit records, and read-back evidence. | Express the requested policy, resolve material ambiguity, inspect differences, and decide subsequent steps. |
| Recurrence | Remain usable by an authorized client or external runner. | Persist and schedule a workflow if the user actually requests recurrence. |

The server does not need an embedded language model or a natural-language command parser. It should not contain special tools such as `apply_final_exam_60_percent_rule`, `compute_section_average`, or `start_week_1_to_9_boolean_grading`.

Optional convenience tools may expose reusable resource operations, such as listing courses or reading a quiz. They must use the same underlying API client and must not be the only way to reach other available APIs. A handful of hand-written wrappers is not sufficient for the intended generality.

## 3. API-only access and authentication

### 3.1 Interaction boundary

Every automated interaction with D2L must use APIs. Prefer documented Brightspace APIs; also allow verified first-party API endpoints used by the Brightspace application when needed. Identify those endpoints and their support status explicitly.

Do not implement operations through clicks, selectors, form filling, iframe editors, screenshots, rendered-page scraping, or navigation through course screens. There is no UI fallback. Reading a public API reference for discovery is distinct from scraping a D2L course page to carry out a task.

The headless browser may maintain the session, obtain authentication material, and execute HTTP requests. Do not expose unrestricted browser control or arbitrary browser JavaScript execution to MCP callers.

A first-party contract must be grounded in evidence, such as documentation, existing application request traces, or application code available through the authenticated session. Do not invent endpoint behavior or use unrequested production changes as API-discovery experiments. Absence from the public reference alone is not proof that an API does not exist.

### 3.2 Session handling

Use a dedicated persistent browser profile. Reuse the authenticated session and verify the current account through an appropriate API. Support an alternative registered/token-based authentication provider when one is configured, but do not make OAuth registration an unconditional prerequisite for browser-session access.

D2L support discussions describe browser-session API requests using session cookies and a CSRF token, including the `XSRF.Token` and `X-Csrf-Token` pattern. Verify the applicable mechanism on the tenant; session authentication and undocumented token routes are not a universal third-party support guarantee. [R1], [R2]

Reuse saved browser/SSO state through one bounded background navigation to the configured tenant entry page, observe only authentication cookies and the configured CSRF slot, and verify the account again by API. Ordinary page redirects/scripts may restore the session; do not inspect course content or automate sign-in controls. Established programmatic token interfaces remain supported. If fresh SSO/MFA requires human interaction, return `AUTHENTICATION_REQUIRED`. An explicit login command may open the dedicated browser for the user to sign in manually. Do not automate the sign-in screens.

Keep cookies, passwords, CSRF tokens, OAuth tokens, and browser-profile contents out of MCP output and ordinary logs. Stored browser authentication state is sensitive. [R3] Do not contend for or copy the user's everyday browser profile.

If a session expires, pause affected requests and explain the authentication requirement. Do not return login HTML as course data or repeatedly retry a failing login sequence.

## 4. General MCP interface

Use a small set of composable tools. The names below are illustrative; their separation and capabilities define the interface.

| Tool | Role |
| --- | --- |
| `d2l_session_status` | Report account identity, tenant, and authentication state without exposing secrets. |
| `d2l_api_versions` | Discover supported API families and versions. |
| `d2l_search_operations` | Search available API descriptions by resource, purpose, parameters, or read/write behavior. |
| `d2l_describe_operation` | Return an operation's contract, schema knowledge, versions, pagination, authentication needs, sources, and limitations. |
| `d2l_api_read` | Invoke a read operation through an operation ID or an explicit tenant-relative API request. |
| `d2l_api_write` | Invoke a mutation with its explicit parameters/body and optional precondition/read-back specification. |
| `d2l_api_paginate` | Retrieve further pages or collect a result using an established pagination contract. |
| `d2l_get_request_status` | Retrieve technical execution, verification, and audit information for a request. |

Separate reads from writes so MCP clients can distinguish their effects. Use accurate SDK tool annotations and schemas. Where an API uses an unusual HTTP method for a read, classify it using its established semantics rather than method alone. Follow current MCP SDK conventions. [R4]

### 4.1 Operation catalog

Maintain a searchable, versioned description of the API surface. Prefer importing or generating metadata from authoritative documentation where practical. Do not assume that every endpoint has an available OpenAPI schema; represent incomplete contract knowledge honestly.

An operation description should include, where known:

- Identifier, resource family, purpose, HTTP method, and path template.
- API family and compatible versions.
- Path/query parameters and request/response schemas.
- Read/write semantics, required permissions, and authentication requirements.
- Pagination, rate-limit, concurrency, and replacement-versus-partial-update behavior.
- Source references and whether the endpoint is documented or a verified first-party interface.
- Separate states for contract knowledge, implementation coverage, and tenant validation.

The catalog is descriptive, not an allowlist of the user's example tasks. Adding a new catalog entry should not require a new MCP tool or a new natural-language branch. Include a documented mechanism for extending and refreshing it.

An operation being documented, its contract being known to this server, and the current user being permitted to invoke it are separate facts. Do not claim tenant validation merely because an endpoint appears in the catalog.

### 4.2 Generic invocation

Support both invocation by catalog operation ID and explicit requests to legitimate tenant-relative API paths. An available API must not become inaccessible merely because no convenience wrapper or catalog entry has been written for it.

An explicit request supplies the method, relative API path, query parameters, and body where relevant. It may also refer to a known contract, expected state, and a follow-up read for verification. Return the level of schema validation actually performed. When the server lacks a schema, say so rather than claiming the operation is unavailable. The caller still needs sufficient contract knowledge to construct a meaningful request.

Constrain this general transport to the configured D2L account and API surfaces:

- Canonicalize paths and restrict authenticated requests to the configured origin and explicitly established API origins/route families.
- Keep identity-provider flows separate from ordinary API invocation.
- Prevent callers from replacing authentication headers or sending credentials to unrelated hosts.
- Inspect redirects before forwarding authentication material.
- Support verified first-party route extensions through configuration or catalog metadata, not through new task-specific code.

This boundary must cover broad authenticated D2L API access without making the server an arbitrary internet proxy. Do not narrow it to the endpoint families used by the examples.

Preserve unknown response fields and distinctions between absent, null, zero, and false. Preserve identifiers without precision loss. Keep units and raw values available. Support the content types required by implemented contracts, and explicitly report unsupported transfer types rather than pretending all API responses are JSON.

### 4.3 Versions, pagination, and large results

Discover LP/LE versions and choose versions compatible with the applicable contract. Compare version components correctly: `1.100` is newer than `1.98`. A request to the highest advertised version is not automatically compatible with an older serializer.

Pagination must follow an established endpoint contract. Do not invent a universal next-page field or silently substitute an endpoint with different coverage. A response should identify retrieval time, coverage, completion status, and continuation state. Follow rate limits and bounded retry policies.

Allow explicit page-by-page retrieval and, where feasible, server-side collection with declared limits. If a limit is reached, return `complete: false` and a continuation. For large results, provide a local export or retrievable result handle so Codex can analyze complete data without placing every record in model context. Protect and expire such result files according to a documented retention setting.

Do not equate an empty result with complete visibility. Brightspace permissions can suppress enrollment records or roles. [R5] Surface known visibility limitations and evidence rather than inventing records or counts.

## 5. Mutation reliability and preservation

### 5.1 Generic facilities

The client chooses the intended change. The server provides reusable facilities for executing and inspecting that change:

- Contract-specific validation and read/write schema translation where implemented.
- Optional before-state capture and precondition checks.
- Conditional requests when the API supports them.
- Technical request IDs, sanitized audit records, and reconciliation of uncertain outcomes.
- Read-back requests and before/after differences.
- Explicit status for an accepted write whose intended effect has not yet been verified.

A successful HTTP status is evidence about a request, not proof that the user's entire goal has been achieved. Return enough information for Codex to verify the result. When the server performs a defined verification itself, state exactly what was checked.

There is no universally safe GET-modify-PUT algorithm. Read and write schemas can differ, and full-object updates may replace unrelated fields. Use an established serializer or a caller-supplied body with an understood contract. Do not turn unknown or redacted values into empty values to make a payload validate.

Retain relevant before-state when needed for diagnosis or a restoration plan, but do not promise atomic rollback across objects or recovery of every legacy value. If external state changes during a workflow, return the conflict and relevant evidence to the client.

### 5.2 Best-effort compatibility adjustments

Support preserving parameters first and reporting necessary adjustments concisely. Compatibility handling should be reusable across operations, with the permitted changes explicit in the request or established workflow policy. It is not a global license to alter unrelated settings.

For a known incompatibility, the normal sequence is:

1. Try the intended mutation while retaining the original setting.
2. After a definitive validation rejection attributable to that setting, try an appropriate omission strategy before explicitly coercing it.
3. Read back any successful request to determine what actually survived or changed.
4. Apply only the smallest necessary normalization allowed by the caller's policy and the established contract.
5. Return actual before/after differences and a concise warning.

Do not retry alternative payloads after an uncertain timeout, authentication failure, permission denial, or rate-limit response as if each were a validation error. Reconcile or resolve the actual problem first.

**Illustrative contract edge case:** the documented quiz read model nests attempt settings, while the write model uses `NumberOfAttemptsAllowed`; the quiz PUT replaces properties. A stored finite count of zero may not be accepted by the write contract. [R9] A client updating that quiz should be able to try preservation, then omission, then a permitted finite default with read-back evidence. Omission is not a guarantee of preservation. Null representing unlimited attempts must not be confused with a missing finite count. Changes between finite and unlimited status require an explicit corresponding policy, not just a warning.

This example motivates schema and verification facilities. It does not require a Boolean-grading feature in the server.

### 5.3 Authorization

A clear user instruction to perform an operation authorizes its defined scope. Do not create a mechanical second-confirmation loop merely because a write uses a separate tool. Respect MCP client/runtime approval controls and distinguish preview requests from requests to apply changes.

The client resolves material ambiguity in scope or policy. The server enforces its account/API boundary and preserves explicit request scope; it should not guess the user's pedagogical intent.

Creating this server is not authorization to modify production courses during development. Validate writes against fixtures, a designated test course, or a separately requested real operation.

## 6. Runtime and deployment

Use TypeScript, a currently supported Node.js LTS release, the official MCP TypeScript SDK, Playwright/Chromium, and a small persistent store where needed. Resolve compatible dependencies during implementation and commit a lockfile. Keep HTTP/authentication code separate from MCP transport and API metadata.

Support local stdio use with Codex. Protocol output belongs on stdout; diagnostics belong on stderr. Document registration using current Codex instructions. [R4], [R11]

Ensure a single owner of the dedicated browser profile. Thin stdio clients attach to an automatically started local session daemon through a private Unix socket. The daemon holds the kernel profile lock and shares one authenticated API client, catalog, store, and serial tool queue across independent MCP protocol sessions. Closing one client does not stop other clients. After one second without connections, the owner drains queued work, closes the browser, and exits. Startup races and login commands must not launch competing profile owners. A disconnected or restarted transport never replays a request.

CLI status uses the shared MCP session. Explicit interactive login uses a separate local control connection, pauses new API tool calls, switches the owner's browser to manual sign-in, and completes capture/identity verification before API calls resume. Only display-related environment values are forwarded from the terminal. There is no MCP browser/login tool, TCP listener, global client registration, or change to the authenticated API boundary. Configuration or bearer-credential mismatches must fail explicitly instead of reusing a different account's session.

Persist only the general infrastructure's state: account configuration, profile, API catalog/cache, request status, and technical audits as needed. Do not introduce tables or services specifically for a 60% exam rule, nine weekly quizzes, or a particular category-weight policy.

Provide commands equivalent to initialization, authentication status, user-completed login, serving MCP, and inspecting request diagnostics. Use appropriate XDG directories and restrictive permissions; keep credentials, profiles, student data, and local state out of source control.

A scheduling service is not required merely because one example could be repeated. If the user later requests recurrence, a client-side script or general external runner can use the same API interface. Its policy, saved mappings, and schedule belong to that workflow. A session daemon's purpose is authentication and request execution, not autonomous course management.

Document installation, browser dependencies, session expiry, login recovery, client registration, and process ownership. A local stdio server does not automatically become reachable from a hosted client; any remote deployment must use an explicitly configured authenticated transport.

## 7. Errors and API capability gaps

Keep transport results and conclusions about an entire user task distinct. A failed request is not proof that every API route to the task is unavailable.

Return a useful classification, such as:

| State | Meaning |
| --- | --- |
| Authentication required | The available session/token cannot authenticate the request. |
| Permission denied | Verified account permissions block it; distinguish possible CSRF/authentication faults. |
| Validation rejected | The endpoint rejected the supplied parameters or body. |
| Version incompatible | The selected contract is not compatible with available API versions. |
| Data incomplete | Retrieval or visibility is insufficient for the stated coverage. |
| Contract unknown | The API's request/response behavior has not yet been established. |
| Server feature missing | A transport, serializer, or transfer type is not yet implemented. |
| API capability unavailable | Evidence establishes the specific missing API operation in this environment. |
| Transient failure | A temporary network/service problem prevented completion. |
| Conflict or uncertain outcome | State changed, or it is not yet known whether a write took effect. |

Include method/path or operation ID, API version, sanitized response evidence, request ID, verification status, and a next API-based diagnostic step when known. Distinguish documented availability, first-party support, and live tenant validation.

Codex uses these results to investigate alternatives and explain the impact on the user's goal. It must not call a task impossible solely because a high-level convenience tool is absent or one endpoint rejected a body. If no adequate API route is established, flag the precise gap. Never substitute UI automation.

## 8. Illustrative compositions

These examples explain how the general interface should be used. They are not dedicated server features, global defaults, or authorization to execute changes. Their parameters come from the actual user request and any explicitly supplied workflow specification.

### 8.1 List current-quarter courses

Codex discovers enrollment and course/term APIs, retrieves the user's complete accessible enrollments, resolves the requested term, and presents the matching course shells. It distinguishes academic-term membership from availability dates or an active flag. Course metadata includes semester relationships. [R5], [R6]

The server supplies requests, pagination, and contract information. It does not need a hard-coded interpretation of “this quarter” or a private list of the instructor's courses.

### 8.2 Apply a conditional final-grade policy

For “give an F when the final exam is below 60%,” Codex inspects the course's calculation and grade scheme, resolves the exam item and missing/exempt-grade behavior, and identifies an API operation for a persistent native rule. It then constructs the requested expression or configuration and verifies it through reads.

The 60% threshold and F policy are request data. They are not server constants. Changing the threshold or adding a condition must not require a new server feature.

A letter-grade scheme, a persistent formula, and an adjusted-final-grade write have different meanings. The generic public grade-object API's limitation on creating Formula/final types does not establish that no first-party configuration endpoint exists. [R8], [R10] If the native operation cannot be reached through an established API, Codex should report that exact gap rather than silently replace it with one-time grade overrides.

### 8.3 Compute averages by section

Codex retrieves the relevant grade measure, roster, and memberships, then uses its own analysis code to join and aggregate them. It decides and reports the treatment of missing, exempt, and zero values and uses the selected grade measure's effective denominator.

“Section” can mean internal sections in one shell or separate shells for the same taught course. Those identities must remain available in API results. The documented section list and paged section list do not have identical coverage; a contract must describe the difference. [R7]

No `compute_average` endpoint in the MCP server is necessary. Other analyses should work by retrieving data through the same interface and changing the client's analysis.

### 8.4 Boolean quiz grading

The earlier Boolean-grading scenario illustrates a composed workflow: award 1 when any submitted attempt completed by its applicable deadline, and 0 otherwise, independent of raw score. It involved Week 1–9, preserved exemptions/comments, included future zeroes, and used a nine-item category with a 9% contribution in a weighted gradebook.

Those are parameters of that scenario. Another request could select different quizzes, another eligibility rule, or another weight without changing the server. The client's workflow specification must make these choices explicit; the generic server must not infer them for every Boolean-grading request.

A client implementing the scenario would use ordinary APIs to:

1. Discover the selected quizzes, associated grade items, category, attempts, deadlines, and special access.
2. Persist the quiz-to-grade-item mapping in its workflow state before unlinking anything.
3. Unlink and disable automatic export where the requested conversion requires it, then verify those prerequisites before changing grade columns.
4. Configure maxima, category contribution, and any other authorized settings, preserving unrelated values and handling API compatibility as in Section 5.
5. Compute participation values and write only the requested changes while preserving exemptions and comments.
6. Read back results and report partial failures or necessary parameter adjustments.

Deadline precedence and retroactive treatment are workflow policy. A verified qualifying attempt can establish a 1; writing 0 requires sufficient complete evidence that no attempt qualifies. A failed retrieval is not “no attempts.” These are correctness requirements for the client workflow, not reasons to add a fixed Boolean policy engine to the MCP server.

If repetition is requested, persist and schedule that composed workflow separately. The MCP server remains the same general API interface.

## 9. Verification and completion criteria

Validate the reusable interface rather than implementing each example as a special feature.

Required tests should cover:

- Session reuse, expiry, CSRF handling, login-response detection, and one profile owner.
- Origin/path restrictions, authentication-header protection, and credential-safe redirects.
- Operation search/descriptions, version selection, unknown catalog entries, and catalog extension without new MCP tools.
- Generic reads and writes across multiple resource families, including an established operation outside the illustrative examples.
- Pagination contracts, explicit incomplete results, continuation, and access to large complete results.
- Correct handling of missing/null/zero/false, identifiers, request serialization, and unknown fields.
- Preconditions, full-object update risks, omission/default behavior, read-back differences, and uncertain-write reconciliation.
- Accurate separation of authentication, permission, validation, incomplete-data, implementation, and API-capability failures.

Demonstrate composition through client-side calls or scripts. At least one demonstration must change a task's parameters or use an additional API operation without adding a task-specific handler. Example demonstrations are evidence of generality, not the complete list of tasks that the server permits.

Keep mocked tests, integration tests, and live tenant checks distinct. Do not claim tenant support based on fixtures. Report any real API limitation or incomplete transport capability precisely, while keeping the general invocation path useful for other operations.

Deliver the executable MCP server, reusable API client, authentication/session management, extensible operation catalog, CLI, tests, lockfile, configuration example, and README. Include setup, Codex registration, a few composed examples, contract-extension instructions, and known coverage gaps. Keep this `DESIGN.md` aligned with the implementation.

Completion means the user can ask varied D2L questions and request varied API-supported changes through Codex using this interface. It does not mean installing a fixed set of teaching automations or implementing the examples as independent products.

## 10. Primary references

### Implementation status (2026-11-02)

The TypeScript implementation uses the official MCP SDK over local stdio, a shared local session owner with a private Unix socket, Playwright's dedicated persistent Chromium profile, Linux kernel profile locking, and private expiring JSON records. Multiple stdio clients and CLI status/login share the owner without competing for the profile. Whole tool calls are serialized across clients; connection loss never replays a request. `README.md` documents installation, the ten composable tools (including result access and catalog refresh), configuration, contract extension, and fixture demonstrations. `catalog/builtin.json` is a reviewed seed catalog with bounded version ranges; explicit API requests remain available outside that catalog. It asserts no live-tenant validation.

The project, npm package, primary CLI command, and MCP server identity are named `brightspace-mcp`. The `d2l-mcp` command remains an alias, and the existing configuration/state paths, environment variables, Codex connection key, and tool names are retained for compatibility with saved authentication and clients.

Node.js 24 remains the LTS baseline; Node.js 26 is additionally supported and has passed the same unit/MCP, real Chromium, and stdio fixture tests. There is no implementation dependency that requires replacing an existing Node 26 installation.

Browser discovery honors an explicit executable, prefers installed Playwright Chromium otherwise, and falls back to installed Linux Chromium when the bundled browser is missing. All launches retain the dedicated profile and ownership lock. Startup diagnostics classify missing browsers, profile conflicts, display failures, dependencies, and process restrictions without returning raw browser logs.

Authentication capture saves session cookies before observing only the tenant's configured CSRF storage key; it does not depend on exporting local storage from every visited SSO origin. Optional storage-observation failures retain the cookie snapshot, observed CSRF material accompanies identity reads as well as mutations, and capture/terminal failures report a safe execution phase. Fixture validation includes the full interactive terminal login sequence; live tenant authentication still requires user-completed sign-in and a successful identity API response.

Browser authentication challenges now receive a single background entry-page refresh and identity API recheck before manual login is requested. Navigation is bounded, temporary pages close, successful state is persisted, and a failed renewal cannot loop within the same process. Reads can retry once following verification; writes are never replayed. Session checks have expiring technical request records containing sanitized initial/final failures and refresh mode/outcome. Local permission, read-only filesystem, and unexpected runtime failures have explicit local error codes instead of claiming a missing server feature. Tool absence in a client session is distinct from authentication and plugin-catalog availability.

Transport values and in-memory observations remain original during version selection, pagination, validation, and state checks. Sanitization occurs on public reports, MCP output, exports, and stored audits, including secret-field numeric provenance, assertions, and differences. Only credential-named or HttpOnly cookies of at least 12 characters enter substring filtering; short cookie flags and ordinary preferences cannot corrupt versions, identifiers, dates, or handles. Short credentials remain protected in authentication headers and sensitive fields. Rotated session cookies are registered before presenting their response. Regression fixtures exercise this boundary through real Chromium, catalog reads, pagination continuations, and MCP result/audit handles.

Implemented request bodies are JSON; response transfers are JSON, text, and private base64 binary exports. Multipart/resumable uploads and streaming downloads remain explicit transport gaps. Browser responses are buffered before the configured size check. Browser-session CSRF requires observed authentication material or a configured, evidenced token interface; token-based access accepts externally issued/renewed bearer tokens. There is no sign-in form automation, remote MCP listener, scheduling service, full quiz serializer, or task-specific teaching-policy handler. A reusable declarative field-map serializer supports extensions with established mappings. Verification consists of stated read-back assertions and differences; it is not a task-completion or rollback guarantee.

Mocked tests, localhost Chromium/stdio integration tests, and the composition demo are separate from live tenant checks. No production course modifications are part of implementation or testing.

The following references support API discovery and the contract distinctions above. Recheck versions and tenant behavior during implementation. No live tenant write validation is asserted by this design.

- **R1 — Browser-session API authentication:** [D2L support discussion](https://community.d2l.com/brightspace/discussion/2359/authorization-tokens-that-keep-expiring).
- **R2 — CSRF and support boundaries:** [D2L AJAX PUT discussion](https://community.d2l.com/brightspace/discussion/473/what-is-the-proper-format-for-making-an-ajax-put-request).
- **R3 — Browser authentication state:** [Playwright authentication](https://playwright.dev/docs/auth).
- **R4 — MCP implementation:** [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server) and [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- **R5 — Enrollments and visibility:** [D2L enrollments](https://docs.valence.desire2learn.com/res/enroll.html).
- **R6 — Courses and term metadata:** [D2L courses](https://docs.valence.desire2learn.com/res/course.html).
- **R7 — Sections and memberships:** [D2L groups and sections](https://docs.valence.desire2learn.com/res/groups.html).
- **R8 — Grades and configuration:** [D2L grades](https://docs.valence.desire2learn.com/res/grade.html).
- **R9 — Quiz contracts and attempts:** [D2L quizzes](https://docs.valence.desire2learn.com/res/quiz.html).
- **R10 — Calculation semantics:** [D2L grading system types](https://community.d2l.com/brightspace/kb/articles/5192-grading-system-types).
- **R11 — Client configuration:** [Codex MCP documentation](https://developers.openai.com/codex/mcp).
