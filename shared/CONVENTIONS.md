# Vojo SDK conventions

Every Vojo SDK follows these rules, whatever its language, so that an integrator who knows one knows them all. Where this says "must", a new SDK is wrong if it differs. Language idiom decides casing and syntax, and nothing else.

An SDK is only a skin over the API. It never changes API behaviour, and it holds no business logic.

## Inputs

Generate from these files, and from nothing else:

| File | What it is |
| --- | --- |
| `api/vojo-api.public.json` | The REST contract, cleaned for public view. Source for models and doc comments. |
| `api/vojo-webhooks.public.json` | The webhook contract, cleaned for public view. Source for event models. |
| `api/operations.json` | One entry per operation and per event, with names and behaviour flags. Source for resources. |
| `webhook-vectors.json` | Verifier test cases. Every SDK must pass all of them, unchanged. |

Generated code and hand-written code stay in separate directories. Where a language needs one package per directory, generated files sit beside hand-written ones under a clear prefix instead (Go: `zz_generated_*.go`). Adding an endpoint must need no hand-written code: regenerate and commit. Each SDK has a check that fails when its generated code is stale.

## Naming

`operations.json` gives each operation a `resource` chain and a `method`, derived from the path. Apply your language's casing and do not rename anything:

```
screens.list                     GET    /v1/screens
screens.retrieve(id)             GET    /v1/screens/{screen_id}
screens.harvester.assign(id, …)  PUT    /v1/screens/{screen_id}/harvester
stats.plays.retrieve             GET    /v1/stats/plays
webhookEndpoints.rollSecret(id)  POST   /v1/webhook-endpoints/{webhook_endpoint_id}/roll-secret
```

- Path parameters are positional, in path order. The query or body comes next, then per-request options.
- Field names on models are the wire names (`snake_case`) unless the language requires otherwise, as with exported Go fields or Java getters. Serialised output is always the wire name.
- Spelling follows the API: `organisation`, not `organization`.

## Client

- The constructor takes the secret key first. A missing or empty key raises an error at construction that names the `VOJO_SECRET_KEY` convention.
- Options: `base_url`, `organisation`, `version`, `timeout`, `max_retries`, and an injectable HTTP client. Timeout and retries can also be set per request.
- The default base URL is `https://api.vojo-media.com`. Contract paths already include `/v1`. Remove a trailing `/` or `/v1` from `base_url`.
- OAuth access tokens use the same constructor argument. OAuth callers also set `organisation`, sent as `Vojo-Organisation`. Secret keys are bound to one organisation and do not need it.
- Both key prefixes are valid. A `vojo_live_` key reaches a live organisation, and a `vojo_test_` key reaches only its own integrator sandbox. Base URL, endpoints and SDK behaviour are the same for both. The SDK must not branch on the prefix: the API answers a key used against the wrong kind of organisation with the same `401` `invalid_token` as any other bad key, so a 401 gets no prefix-specific hint.
- Every object and webhook event carries `livemode`: `true` for live, `false` for a sandbox. SDKs expose it as an ordinary generated field.
- An organisation owner creates keys in the Vojo portal, under **Developers → API keys** (live) or **Developers → Sandboxes** (test). Docs say that and link to https://developers.vojo-media.com, and never tell readers to ask a Vojo contact.
- `User-Agent` is `vojo-<language>/<sdk version>`.

## Version pinning

Send `Vojo-Version` on every request, set to `api_version` from `operations.json`. The caller can override it on the client or per request. The SDK must not interpret the version beyond sending it.

## Responses

`operations.json` sets `response.returns`:

| `returns` | The method gives back |
| --- | --- |
| `data` | The contents of `data` |
| `envelope` | `data` and `meta`, because `meta` carries real information (stats responses, for example) |
| `page` | An auto-paging list (see below) |
| `void` | Nothing |

Unknown response fields and enum values must be tolerated: `/v1` grows additively. Never validate responses strictly against the schema.

Every non-void result must also expose the HTTP status, headers, request id (`Vojo-Request-Id`), `meta`, and whether it was an idempotent replay (`Idempotent-Replayed: true`), in whatever way suits the language.

## Pagination

Operations with `paginated: true` return an object that can do both of these:

1. Fetch the first page, exposing its items and `meta`.
2. Iterate every item across pages, fetching lazily.

Iteration rules, which must all be tested against a stub server:

- `has_more` is authoritative. If it is false, stop, even if a cursor came back.
- An empty-string cursor is the same as no cursor.
- `has_more: true` with no cursor raises a pagination error.
- A cursor already followed, including one the caller passed in, raises a pagination error instead of looping.
- Page size is `limit`, at most 100. Do not clamp or validate it in the SDK.

The mock server replays one fixed response, so auto-paging against it must raise the repeated-cursor error. That is correct behaviour.

## Errors

All errors share one base type. API errors expose `status`, `code`, `problem` (the whole problem+json body), `request_id` and `headers`. `code` may be a value the SDK has never seen: never fail on an unknown code, and classify by status.

| Kind | Status | Notes |
| --- | --- | --- |
| Authentication | 401 | |
| Permission | 402, 403 | 402 means a plan limit: `feature_key`, `limit` and `used` are in `problem` |
| NotFound | 404 | Hint added for an operation with `available_in_early_access: false` |
| Validation | 400, 413, 422 | Exposes the field errors from `problem.errors` |
| Conflict | 409 | |
| RateLimit | 429 | Exposes `retry_after` in seconds |
| Server | 5xx | Also when the body is not problem+json (a proxy's HTML page, for example) |
| API (base) | any other status, including 3xx | |
| Connection | no response | Timeout is a sub-kind |
| Pagination | | The guards above |
| WebhookVerification | | Exposes `kind` (see Webhooks) |

Only a 2xx is a success. Anything else is an error, even with an empty or JSON body. The API never redirects, so an SDK must not follow redirects: following one can turn a POST into a GET that looks like a success, and can resend the credential. Turn following off, on an injected HTTP client too. The message for a 3xx adds a hint to check `base_url`.

How each language turns following off:

| Language | Rule |
| --- | --- |
| TypeScript | Send `redirect: "manual"` on every request, including through an injected `fetch`. A response with `type: "opaqueredirect"` (status 0, as browsers return) counts as a 3xx |
| Python | Send `follow_redirects=False` on every request, which overrides an injected `httpx` client |
| Go | Copy the HTTP client, injected or default, and set `CheckRedirect` to return `http.ErrUseLastResponse` on the copy. Never change the caller's client |
| Java | Use `followRedirects(NEVER)` on the default client. Refuse an injected `HttpClient` whose `followRedirects()` is not `NEVER`, at construction |

The message is `detail`, else `title`, else a generic line with the status. A Validation error also appends its field errors, so that logs and uncaught errors say what was wrong:

```
7 fields failed validation. /name (required): Name is required; /limit (too_large): Too large; /site_id (not_found): No such site; /starts_at (invalid): Not a date; /tags/0: Too long; and 2 more
```

The message is the base message, one space, then the entries joined with `; `. Nothing is added to or removed from the base message, so it is used whether or not it ends in a full stop.

Each entry is `<pointer> (<code>): <detail>`. A part is used only when it is a non-empty string: anything else, such as a number or an object, counts as missing and is left out, together with its brackets or colon. An entry with no usable part is skipped and does not count. List at most 5 entries. If more remain, add a final `and <n> more` entry, joined with `; ` like the others. When no entry is usable the base message is unchanged. Other kinds do not append anything. The field errors stay available in full on the error.

Secret keys must never appear in a message, log, debug print or string form of the client: redact anything matching `vojo_(live|test)_\w+` in error text, including text from underlying network errors.

## Idempotency

For operations with `idempotency_key: true`:

- Generate a UUID v4 once per logical call, and reuse it on every retry of that call.
- The caller can supply their own key per request, and then the SDK must not generate one.
- Keys are stored by the API for 24 hours.

Do not send the header on any other operation.

## Retries

Defaults: `max_retries` 2, so at most 3 attempts. Delay starts at 0.5s, doubles each attempt, is capped at 8s, and has jitter applied. A valid `Retry-After` replaces the computed delay and is used as given: no jitter and no 8s cap, since the server chose the wait. A valid `Retry-After` above 60s is not slept through, on any status in the table below: return the error to the caller. Exactly 60s is still slept.

`Retry-After` is valid when, with surrounding whitespace removed, it is only digits with an optional fraction (`^[0-9]+(\.[0-9]+)?$`), read as seconds:

| Value | Meaning |
| --- | --- |
| `3`, `2.5` | Wait that long |
| `0` | Retry with no wait |
| `3600`, or digits too long for the language's number type | Longer than 60s: return the error |
| Absent, empty, negative, `1e3`, `inf`, `nan`, an HTTP-date, anything else | Not given: use the computed delay |

The API sends seconds, so an HTTP-date is not parsed. The `retry_after` on a RateLimit error follows the same rule, and is unset when the value is not valid.

| Outcome | `retry_safe: true` (GET, PUT, DELETE, keyed POST) | `retry_safe: false` (PATCH, unkeyed POST) |
| --- | --- | --- |
| Connection never opened (refused, DNS failure) | Retry | Retry |
| Connection lost or timed out after sending | Retry | Do not retry |
| 429 | Retry | Retry (rejected before the handler runs) |
| 5xx | Retry | Do not retry |
| 409 `idempotency_request_in_progress` | Retry | Not applicable |
| Any other status | Do not retry | Do not retry |

A retried DELETE can return 404 if an earlier attempt succeeded but its response was lost. Surface that as NotFound and do not hide it.

## Timeouts

Default 60 seconds per attempt, including reading the body, so a server that stalls or trickles the body cannot hold a call past it. Configurable on the client and per request.

## Cancellation

A caller's cancellation is not a failure to retry. It stops the call at once, including during a wait between retries, and nothing further is sent. It surfaces the way the language expects, so that existing cancellation handling keeps working:

| Language | Cancelled by | The caller sees |
| --- | --- | --- |
| TypeScript | `AbortSignal` | The signal's `reason`, an `AbortError` by default. Not wrapped in a Vojo error |
| Python | Cancelling the `asyncio` task (async client) | `asyncio.CancelledError`. Not wrapped in a Vojo error |
| Python | Nothing in the sync client | Only the timeout ends a sync call. A `KeyboardInterrupt` passes through unwrapped and is never retried |
| Go | The `context` | `ConnectionError` unwrapping to `context.Canceled` or `context.DeadlineExceeded`. `Timeout` is set for a deadline |
| Java | Interrupting the thread | `ApiConnectionException`, with the thread's interrupt flag restored. Calls are synchronous; any future used inside an attempt is cancelled |

In Go, the caller's deadline and the SDK's own per-attempt timeout both end in `context.DeadlineExceeded`. Give each attempt a child context of the caller's. Treat an error as the caller's only when the caller's context is done, and never retry it. Otherwise it is an attempt timeout, which retries as a lost connection.

A new SDK picks its language's convention and adds it here.

## Webhooks

The verifier must work without an API key or client: expose it standalone as well as on the client.

**Input:** the raw body bytes, the `X-Vojo-Signature` header value, one secret or a list of secrets, and optionally `tolerance` (default 300 seconds) and `now`. If the caller passes a parsed object in place of raw bytes, raise an error that explains why.

**Algorithm:**

1. Absent or empty header: `missing_header`. The message says an endpoint whose secret predates signing sends no header until its secret is rolled.
2. Split on `,`, trim each part, split each on the first `=`. Ignore schemes other than `t` and `v1`.
3. Exactly one `t` made only of digits, and at least one `v1`, or `malformed_header`.
4. For every secret and every `v1`: compute HMAC-SHA256 over the bytes of `<t as sent>.` followed by the raw body, as lowercase hex, and compare in constant time. Any match passes. Never depend on the position or number of `v1` values. Hex that is malformed or the wrong length simply does not match, and never throws. No match: `no_matching_signature`.
5. `|now - t| > tolerance`: `timestamp_out_of_tolerance`. Exactly `tolerance` passes. There is no way to turn the check off, so `tolerance` must be a finite number above 0 and at most 86400 seconds (one day). Anything else, such as zero, a negative, infinity or NaN, is a programming error, raised before the delivery is looked at.
6. Parse the JSON. Failure: `invalid_payload`.

Check the signature before the timestamp, as the vectors expect.

**Output:** a normalised event:

| Field | Value |
| --- | --- |
| `type` | `eventType`, or `event_type` on newer events |
| `id` | `eventId`, or `event_id`. Dedupe on this: it stays the same across retries |
| `attempt_id` | `attemptId`, or `attempt_id`. Changes on every retry |
| `payload` | The whole parsed body, typed by `type` where the language allows |

Unknown event types must verify and parse normally. Signature prefixes on secrets (such as `vwsec_`) must not be checked.

Also provide a helper that signs a test payload, so integrators can test their own handlers.

## Repository contents

Each public SDK repo has `README`, `LICENSE` (MIT), `CHANGELOG`, `SECURITY`, `CONTRIBUTING`, its generated code, its runtime, and a copy of these shared files. The README opens with a working first call, states that keys are issued by Vojo during early access, and shows a webhook handler. Packages stay pre-1.0 and unpublishable until Vojo decides otherwise.

## Tests every SDK must have

- All of `webhook-vectors.json`, unchanged, plus a mutation check: break the verifier and confirm the tests fail.
- Pagination guards, retry table, `Retry-After` values, idempotency-key reuse across retries, error mapping, field errors in the message, a 3xx as an error, cancellation and secret redaction, against a stub server.
- A tolerance of zero, a negative, 86401 and, where the language can express them, infinity and NaN are all refused.
- Examples run against a Prism mock of `api/vojo-api.public.json`.
