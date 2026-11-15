# Potential future features

This is a candidate roadmap for an **instructor-facing, API-only** Brightspace MCP server, governed by [DESIGN.md](DESIGN.md) and informed by the [comparison in README.md](README.md#scope-and-comparison) and source reviewed on 2026-10-23. Priorities express intended order of evaluation. Each candidate requires contract research, implementation, and appropriate validation before it can be described as supported.

## Governing boundaries

- Course data and changes must use documented or evidenced first-party APIs. Browser use remains limited to human sign-in and bounded session maintenance; course-page scraping, form automation, and UI fallbacks are excluded.
- Features serve instructor course management and analysis within the account's actual API permissions. Student-facing homework-submission, to-do, and target-grade apps, unrelated LMS integrations, and broad super-admin provisioning are outside the intended product scope. Instructor-requested calculations remain valid client-side analysis.
- Extend the general tools, declarative catalog, serializers, and transports first. Reusable resource conveniences may compose these primitives; teaching policies, grading formulas, course selection, workflow persistence, and scheduling remain client responsibilities.
- Keep documented contracts, implemented behavior, and tenant validation separate. Authentication/permission failures and version mismatches must not become claims that a task is globally impossible. Fixture success alone does not prove tenant support.
- New mutation paths retain optional previews, explicit preconditions/read-back, honest uncertain outcomes, and durable diagnostics. Client approval controls apply; an authorized multi-object workflow should not acquire a mandatory confirmation-token round trip for every object.

## Priority 1: Instructor contracts and validation

Expand reviewed contracts for gradebook objects/categories, score and feedback operations, exemptions, quiz settings, announcements, assignments, and content management where the APIs and instructor permissions support them. Start with the current grade and quiz update gaps rather than adding more general transport entry points.

- Record version bounds, read/write model differences, replacement semantics, paging, and evidence for each operation.
- Add serializers for rich-text and nested structures only where preservation behavior is understood. Reject missing or redacted required values; preserve the distinctions between absent, null, false, zero, and unlimited settings.
- Report API-observable roles/capabilities as diagnostic evidence. Avoid assuming a universal instructor role name or treating a successful preflight as proof a subsequent write will be permitted.
- Add fixtures for legacy values, unknown fields, denied access, partial reads, conditional conflicts, and successful writes followed by failed verification. Separately authorized sandbox checks can establish tenant-specific write behavior.

**Completion evidence:** reviewed source-backed contracts, regression fixtures, and explicit validation labels. A full quiz serializer remains unsupported until its rich-text and protected-field requirements are resolved.

**Inspiration:** [Lamaku's authoring work][lamaku] and our existing contract/verification pipeline. Its tenant-specific conclusions must be rechecked rather than generalized.

## Priority 1: API file transfers and course authoring

The current server sends JSON bodies only. Add reusable, bounded multipart/streaming transports before promising media uploads, attachment writes, or course-package imports.

- Stream user-selected files through the appropriate API contract; enforce transfer limits and private temporary storage, and clean up partial transfers.
- Support API-based content pages/modules/topics, announcements, and assignment configuration through the same catalog and mutation workflow. Include visibility and release behavior in the reviewed contract and preview.
- Where an established import API permits it, support package upload, asynchronous job status, and post-import inspection. Explore quiz-question or rubric imports only after verifying the relevant format, route, version, and permissions.
- Preserve the originating request/job identifiers after a timeout. Reconcile status instead of resending uploads or import jobs. Polling must be bounded and resumable.

**Completion evidence:** fixture-backed multipart/streaming and failure recovery, then authorized sandbox verification of individual authoring/import contracts. A missing API capability remains a precise limitation with no UI fallback.

**Inspiration:** [Lamaku's pages, media, and imports][lamaku]; [RobertLMcCrary's bounded upload implementation][robert-writes]. Adopt transport techniques for instructor authoring, not their student-submission workflows.

## Priority 1: Student-identity disclosure controls

Add optional, explicit presentation policies for instructor reads and exports: stable student pseudonyms, field selection, and deliberately requested disclosure of necessary identifiers. Credential redaction already exists; general student pseudonymization does not.

- Scope pseudonyms and any private ID mapping to the tenant/account. Make policies consistent across tool results, paginated segments, exports, errors, and audit snapshots.
- Keep original API data intact for internal routing, validation, state assertions, and verification. Apply disclosure policies at output/storage boundaries rather than replacing arbitrary substrings.
- Define how a pseudonym can safely target an instructor-authorized operation without exposing the underlying identity or mixing students across tenants.
- Explain remaining disclosure paths, including free text, attachments, and previously exported data. Pseudonymization is a disclosure control, not a general compliance guarantee.

**Completion evidence:** tests covering joins, continuations, exports, request-status records, and explicit identity disclosure; preserved correctness of API requests and comparisons.

**Inspiration:** [Lamaku's local pseudonymization implementation][lamaku-privacy].

## Priority 1: Diagnostics and credential lifecycle

Add a `doctor` command that distinguishes build/configuration problems, state-directory write restrictions, profile ownership, browser dependencies, network access, authentication, CSRF, and API-version issues. Its default checks should avoid opening a login window or touching course resources; any live identity/refresh check should be explicit.

- Reuse the existing local error classification and session-check request records. Explain when to recheck a session, when interactive login is necessary, and when filesystem/process access needs correction instead.
- Provide a bounded, sanitized diagnostic bundle with no cookies, tokens, profile contents, student data, or unreviewed raw browser logs.
- Add explicit logout/credential clearing for the dedicated state directory, coordinated with its owner. Describe the difference between clearing local state and server-side session revocation where a provider supports it.
- Consider OS credential stores or encrypted authentication snapshots where usable. Preserve a clear headless/CI configuration path and document what remains in the browser profile or data exports.

**Completion evidence:** offline diagnostic fixtures, restricted-filesystem cases, concurrent-owner cases, and safe credential lifecycle checks using isolated state directories.

**Inspiration:** [RohanMuppa's setup and doctor experience][rohan], [AnonymousOnyx22's diagnostics][onyx], and [JhostinAleck's credential-store options][jhostin]. Password/MFA form automation is excluded.

## Priority 2: Resumable instructor workflows

Build client-side batch plans on the existing request records, preconditions, and reconciliation support. Examples include a caller-selected set of quiz-setting changes or gradebook-object updates; course selection and policy stay explicit inputs.

- Show intended per-object changes, retain a stable plan identity, checkpoint progress, and report succeeded, conflicted, failed, and uncertain items independently.
- Resume by reconciling uncertain requests first. Consider local duplicate suppression tied to tenant, account, method, target, body, and workflow identity; do not interpret a local key as server-side idempotency or exactly-once delivery.
- Protect concurrent execution and crashes without promising a transaction across courses. A second submission of a plan must not silently repeat already-completed mutations.
- Any restoration plan needs separately understood write contracts and fresh preconditions; a stored snapshot alone does not prove a safe rollback exists.

**Completion evidence:** interruption/restart and concurrency fixtures, unchanged-object checks, and no automatic replay after ambiguous outcomes.

**Inspiration:** [JhostinAleck's persistent idempotency and audit mechanisms][jhostin-writes], adapted to instructor workflows and our uncertain-outcome model.

## Priority 2: Instructor reading and analysis conveniences

Expand contract coverage for instructor-visible submissions, feedback, rubrics, groups/sections, release conditions, calendars, and course configuration. Return source identifiers, units, retrieval times, coverage limits, and visibility restrictions so a client can perform the requested analysis.

- Add bounded local text extraction and search over API-downloaded documents where useful. Retain original-file references and distinguish extracted text from source data.
- Consider MCP resources and prompts for course configuration summaries, completeness reviews, and requested-change planning, composed from the general API tools.
- Add useful export formats for instructor analysis with field selection, pagination provenance, and disclosure policies. Preserve exact identifiers and absent/null/zero distinctions.
- Do not scrape course pages or embedded LTI screens to discover hidden content. External integrations require a separately evidenced API and an explicit scope decision.

**Completion evidence:** API-backed fixtures, bounded parser/search behavior, and honest partial-data reporting. No teaching or grading policy is inferred from the convenience interface.

**Inspiration:** [RohanMuppa's instructor readers and document handling][rohan] and [JhostinAleck's resources/prompts][jhostin-tools], adapted for instructor use rather than student-facing planning apps.

## Priority 2: Managed registered OAuth provider

Add an optional authorization-code/refresh-token provider for institutions that permit application registration. Keep the existing browser-session provider available without making registration mandatory.

- Model instructor scopes and consent explicitly. Coordinate rotating refresh tokens across a single owner and persist them atomically in protected storage.
- Distinguish token expiry, revoked consent, missing scope, and course-role permissions. Describe how unattended client workflows receive an actionable authentication failure.
- Support standard established programmatic flows rather than automating password or MFA forms.

**Completion evidence:** mock authorization/token services, rotation and interruption tests, and separately authorized tenant setup verification.

**Inspiration:** [Brightspace Admin MCP's OAuth renewal][admin] and [JhostinAleck's authentication strategies][jhostin]. Administrator provisioning and bulk Data Hub access are not prerequisites or new product goals.

## Priority 2: Packaging, installation, and platform support

- Add automated CI for type checking, fixture/MCP tests, and isolated Chromium/stdio integration checks. Keep live tenant and production-write checks outside unattended default CI.
- Provide release artifacts and an easier local setup/check flow. Evaluate macOS and Windows after replacing Linux-specific ownership/browser assumptions with tested equivalents.
- Preserve the current command alias, environment variables, configuration/state locations, and opt-in Codex launcher during any migration.
- Choose an explicit license before public distribution. If publishing to npm, use a distinct scoped name such as `@owner/brightspace-mcp`; the unscoped name already identifies [JhostinAleck's package][jhostin].

**Completion evidence:** clean-install and upgrade checks, existing-session reuse, dependency/lock consistency, and one-owner guarantees on each supported platform.

**Inspiration:** [RobertLMcCrary's cross-platform releases][robert] and [RohanMuppa's setup experience][rohan].

## Optional: Authenticated HTTP transport

Multiple local stdio clients now share one session owner and serial tool queue through a private Unix socket. Further work could add an explicitly configured, authenticated MCP HTTP transport. Keep stdio as the default.

- Serialize mutation sequences, preserve request attribution and account identity, and handle disconnected clients and uncertain in-flight writes.
- Bind locally by default, enforce transport authentication and origin controls, and define shutdown/ownership behavior before adding remote deployment options.
- Preserve the existing opt-in client registration and start the owner only for enabled connections. Avoid a background task scheduler. Client workflows retain scheduling responsibility.

**Completion evidence:** multiple-client and reconnect tests, authenticated transport tests, preserved profile ownership, and no startup changes for ordinary Codex sessions.

**Inspiration:** [RohanMuppa's optional shared HTTP service][rohan].

## Evaluation rule

For every candidate, identify the instructor use, supporting API evidence, reusable infrastructure change, known version/permission limits, and expected verification before implementation. Mark progress as researched, implemented against fixtures, and tenant-validated separately. An idea inspired by another project is a starting point for evaluation, not evidence that the same API behavior is available on every tenant.

[rohan]: https://github.com/RohanMuppa/brightspace-mcp-server/blob/524182cd434863a73e6a50b01d342ef24c65a2eb/README.md
[onyx]: https://github.com/AnonymousOnyx22/brightspace-d2l-mcp/blob/1ffcc4ad7a658bd553acaac1bf3a0ede0c08730e/README.md
[jhostin]: https://github.com/JhostinAleck/brightspace-mcp/blob/1b85c44fce9eb0d392961f52998a19e8571fdbf6/README.md
[jhostin-writes]: https://github.com/JhostinAleck/brightspace-mcp/blob/1b85c44fce9eb0d392961f52998a19e8571fdbf6/docs/writes.md
[jhostin-tools]: https://github.com/JhostinAleck/brightspace-mcp/blob/1b85c44fce9eb0d392961f52998a19e8571fdbf6/docs/tools.md
[robert]: https://github.com/RobertLMcCrary/D2L-MCP/blob/1244d84268032114a4459a6090bd0657e869a96f/README.md
[robert-writes]: https://github.com/RobertLMcCrary/D2L-MCP/blob/1244d84268032114a4459a6090bd0657e869a96f/docs/D2L_WRITES.md
[lamaku]: https://github.com/JesseTho/lamaku-mcp/blob/210083a86ff4ebbbfc60db0af72fc916c5e589c9/README.md
[lamaku-privacy]: https://github.com/JesseTho/lamaku-mcp/blob/210083a86ff4ebbbfc60db0af72fc916c5e589c9/src/privacy.ts
[admin]: https://github.com/mcreed-mlri/brightspace-admin-mcp/blob/c59befe3c9ec6bd633685983d1e1067e0696d26b/README.md
