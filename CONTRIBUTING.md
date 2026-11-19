# Contributing

Bug reports and pull requests are welcome.

## Setup

```bash
npm ci
npm test
```

## What goes where

- `src/generated/` is generated from the API contract. Do not edit it: run `npm run generate`. `npm run check:generated` fails if it is stale.
- `src/*.ts` is the hand-written runtime: requests, retries, paging, errors and webhooks.
- `shared/` holds the contract copies, the rules every Vojo SDK follows (`shared/CONVENTIONS.md`) and the webhook test vectors. These come from Vojo and are copied here, so changes to them need to be made by Vojo.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run test:mutation
npm run examples
npm run build
```

`test:mutation` breaks the webhook verifier in many small ways and checks that the tests notice. If you change the verifier, keep it passing.

This library has no runtime dependencies. Please keep it that way.
