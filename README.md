# Vojo TypeScript SDK

The official TypeScript and JavaScript client for the [Vojo](https://vojo-media.com) API: register screens, wrap creatives with the Vojo Passport, and get proof of each play back.

> **Early access.** This library is pre-1.0, and the API serves part of its surface so far ([list](src/generated/API.md)).

## Install

```bash
npm install vojo
```

Needs Node.js 20 or later. It has no runtime dependencies.

## First call

An organisation owner creates keys in the Vojo portal. A live key starts with `vojo_live_` and comes from **Developers → API keys**. A test key starts with `vojo_test_` and comes from **Developers → Sandboxes**: it reaches only its own sandbox, with the same base URL and endpoints. Objects returned with a test key have `livemode` set to `false` (`organisation.livemode`). See [Authentication](https://developers.vojo-media.com/getting-started/authentication) and [Test in a sandbox](https://developers.vojo-media.com/guides/test-in-a-sandbox) on https://developers.vojo-media.com.

```ts
import Vojo from "vojo";

const vojo = new Vojo(process.env.VOJO_SECRET_KEY);

const organisation = await vojo.organisation.retrieve();
console.log(`Connected to ${organisation.name}`);
```

Keep your key on your server. The client refuses to start in a browser, because anyone can read a key from a page.

## Create things

```ts
const site = await vojo.sites.create({
  name: "Leeds Trinity",
  address: { street: "1 Market Street", city: "Leeds", postal_code: "LS1 6DT", country: "GB", latitude: 53.7966, longitude: -1.5432 },
});

const screen = await vojo.screens.create({ name: "Lobby North", site_id: site.id, size_inches: 55 });

const wrapper = await vojo.wrappers.create({
  content_source: "https://cdn.example.com/creatives/77.mp4",
  content_type: "video",
  screen_id: screen.id,
  external_id: "creative-77",
  source: "YOUR_CMS",
  duration: 15,
  delivery_mode: "archive",
});
```

Field names match the API exactly, in `snake_case`. A wrap can answer with status `processing`: see [examples/cms-flow.ts](examples/cms-flow.ts) for how to wait for it. Check `wrapper.lastResponse.meta.warnings` too, because that is where the API warns you about a wrapper with no `screen_id`.

Methods follow the API's paths: `vojo.screens.retrieve(id)`, `vojo.screens.harvester.assign(id, body)`, `vojo.webhookEndpoints.rollSecret(id)`. Your editor will show the rest, or see the [full list](src/generated/API.md).

## Lists

`for await` walks every item across every page, fetching more as it goes:

```ts
for await (const screen of vojo.screens.list({ has_harvester: true })) {
  console.log(screen.name);
}
```

`await` gives you one page, if you want to page yourself:

```ts
const page = await vojo.screens.list({ limit: 100 });
console.log(page.data.length, page.meta.has_more, page.meta.next_cursor);
```

To collect into an array, say how many you are willing to hold: `await vojo.screens.list().toArray({ limit: 5000 })`.

## Webhooks

Verifying needs only the endpoint's signing secret, not an API key. Pass the **raw** request body, because the signature covers the exact bytes Vojo sent.

```ts
import express from "express";
import { webhooks, VojoWebhookVerificationError } from "vojo";

const app = express();

app.post("/vojo", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = webhooks.constructEvent(req.body, req.get("X-Vojo-Signature"), process.env.VOJO_WEBHOOK_SECRET!);
  } catch (error) {
    if (error instanceof VojoWebhookVerificationError) return res.status(400).end();
    throw error;
  }

  res.status(204).end(); // Acknowledge first, then do the work.

  switch (event.type) {
    case "verification.ping":
      console.log(`Play ${event.payload.playId} was reported`);
      break;
    case "verification.score":
      console.log(`Play ${event.payload.playId} scored`);
      break;
    default:
      // New event types can arrive before you upgrade.
      console.log(`Ignoring ${event.type}`);
  }
});
```

Deliveries can repeat, so dedupe on `event.id`, which stays the same across retries.

While you switch to a new secret after a roll, pass both, and either one will verify: `constructEvent(body, header, [newSecret, oldSecret])`.

To test your own handler, sign a payload with `webhooks.generateTestHeader({ payload, secret })`.

| `error.kind` | Meaning |
| --- | --- |
| `missing_header` | No signature. An endpoint whose secret predates signing sends none until you roll its secret. |
| `malformed_header` | The header is not in the expected form. |
| `no_matching_signature` | Wrong secret, or the body changed. A parsed and re-serialised body fails here. |
| `timestamp_out_of_tolerance` | More than 300 seconds from now. Check your clock. Change the window with `{ tolerance }`, up to 86400 seconds. |
| `invalid_payload` | The signature is fine but the body is not a valid event. |

## Errors

```ts
import { VojoConflictError, VojoValidationError } from "vojo";

try {
  await vojo.screens.create({ name: "Lobby North", size_inches: 55 });
} catch (error) {
  if (error instanceof VojoValidationError) {
    for (const field of error.fieldErrors) console.error(field.pointer, field.detail);
  } else if (error instanceof VojoConflictError && error.code === "duplicate_name") {
    console.error("That name is taken.");
  } else {
    throw error;
  }
}
```

| Class | When |
| --- | --- |
| `VojoAuthenticationError` | 401: the key is missing, invalid, expired or revoked |
| `VojoPermissionError` | 402 or 403: a missing scope or permission, or a plan limit |
| `VojoNotFoundError` | 404: not found, or it belongs to another organisation |
| `VojoValidationError` | 400, 413 or 422: see `fieldErrors` |
| `VojoConflictError` | 409 |
| `VojoRateLimitError` | 429: see `retryAfter` |
| `VojoServerError` | 5xx |
| `VojoConnectionError` | No response. `VojoTimeoutError` is the timeout case |
| `VojoPaginationError` | The API's paging data could not be followed safely |

API errors all extend `VojoAPIError`, with `status`, `code`, `problem` (the full response body) and `requestId`. Quote `requestId` when you contact Vojo. Branch on `code` rather than on message text. The API can add new codes, so always handle an unknown one.

## Retries and idempotency

You usually have nothing to do here. Failed requests are retried twice, with backoff, when that is safe:

- Every request: rate limits (429, honouring `Retry-After`), and connections that never opened.
- `GET`, `PUT`, `DELETE` and creates: also 5xx errors and dropped connections.
- `PATCH` and other `POST`s are not retried after those, because the first attempt may have worked.

A `Retry-After` is honoured up to 60 seconds. Beyond that, you get the error straight away and decide what to do.

Only a 2xx counts as success. Redirects are not followed: the API does not send them, so a 3xx raises `VojoAPIError` and usually means `baseUrl` is wrong.

To cancel a call, pass `signal`. It stops the call at once, even between retries, and rejects with the signal's `reason` (an `AbortError` by default) rather than a Vojo error.

Every create is sent with an `Idempotency-Key`, reused across its retries, so a retry never makes a second resource. To retry across your own restarts, supply your own:

```ts
await vojo.sites.create(body, { idempotencyKey: `site-${yourRecord.id}` });
```

The API keeps keys for 24 hours. Check `site.lastResponse.idempotentReplayed` to see whether you got a stored response.

## Options

```ts
const vojo = new Vojo(key, {
  timeout: 30_000, // per attempt, in ms. Default 60000
  maxRetries: 5, // default 2
  version: "2026-10-07", // default: the version this SDK was generated against
  organisation: "org_id", // OAuth callers only. Secret keys are bound to one organisation
});

// Most of them work per request too:
await vojo.screens.retrieve(id, { timeout: 5_000, maxRetries: 0 });
```

OAuth callers pass their access token in place of the key, and set `organisation`.

Every result also has `lastResponse`, with `status`, `headers`, `requestId`, `apiVersion`, `idempotentReplayed` and `meta`. It does not appear in `JSON.stringify` or when you loop over the result.

## Types

```ts
import type { Screen, Site, WebhookEvent } from "vojo";
```

## More

- [Examples](examples)
- [Every method](src/generated/API.md)
- [Changelog](CHANGELOG.md), [security](SECURITY.md), [contributing](CONTRIBUTING.md)

## Licence

[MIT](LICENSE)
