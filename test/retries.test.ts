import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VojoConflictError, VojoConnectionError, VojoRateLimitError, VojoServerError, VojoTimeoutError } from "../src/index";
import { Transport } from "../src/core";
import { VojoResources } from "../src/generated/resources";
import { connectionError, ok, problem, scripted, TEST_KEY } from "./helpers";

const site = { name: "Leeds" } as never;

describe("retry table", () => {
    it("GET retries a lost connection", async () => {
        const { vojo, sent } = scripted([connectionError("ECONNRESET"), ok({ id: "s1" })]);
        assert.equal((await vojo.screens.retrieve("s1")).id, "s1");
        assert.equal(sent.length, 2);
    });

    it("GET retries a 5xx", async () => {
        const { vojo, sent } = scripted([problem(500, "internal_error"), problem(503, "internal_error"), ok({ id: "s1" })]);
        await vojo.screens.retrieve("s1");
        assert.equal(sent.length, 3);
    });

    it("gives up after maxRetries and raises the last error", async () => {
        const { vojo, sent } = scripted([problem(500, "internal_error"), problem(500, "internal_error"), problem(500, "internal_error")]);
        await assert.rejects(vojo.screens.retrieve("s1"), VojoServerError);
        assert.equal(sent.length, 3);
    });

    it("maxRetries 0 turns retries off, on the client and per request", async () => {
        const client = scripted([problem(500, "internal_error")], { maxRetries: 0 });
        await assert.rejects(client.vojo.screens.retrieve("s1"), VojoServerError);
        assert.equal(client.sent.length, 1);
        const perRequest = scripted([problem(500, "internal_error")]);
        await assert.rejects(perRequest.vojo.screens.retrieve("s1", { maxRetries: 0 }), VojoServerError);
        assert.equal(perRequest.sent.length, 1);
    });

    it("keyed POST retries a 5xx and a lost connection", async () => {
        const { vojo, sent } = scripted([problem(500, "internal_error"), connectionError("ECONNRESET"), ok({ id: "st1" }, 201)]);
        await vojo.sites.create(site);
        assert.equal(sent.length, 3);
    });

    it("PATCH does not retry a 5xx or a lost connection", async () => {
        const server = scripted([problem(500, "internal_error")]);
        await assert.rejects(server.vojo.screens.update("s1", {} as never), VojoServerError);
        assert.equal(server.sent.length, 1);
        const lost = scripted([connectionError("ECONNRESET")]);
        await assert.rejects(lost.vojo.screens.update("s1", {} as never), VojoConnectionError);
        assert.equal(lost.sent.length, 1);
    });

    it("unkeyed POST does not retry a 5xx or a lost connection", async () => {
        const server = scripted([problem(500, "internal_error")]);
        await assert.rejects(server.vojo.webhookEndpoints.rollSecret("e1"), VojoServerError);
        assert.equal(server.sent.length, 1);
        const lost = scripted([connectionError("ECONNRESET")]);
        await assert.rejects(lost.vojo.webhookEndpoints.deliveries.retry("e1", "d1"), VojoConnectionError);
        assert.equal(lost.sent.length, 1);
    });

    it("unsafe requests still retry when the connection never opened", async () => {
        for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
            const { vojo, sent } = scripted([connectionError(code), ok({ id: "s1" })]);
            await vojo.screens.update("s1", {} as never);
            assert.equal(sent.length, 2, code);
        }
    });

    it("every method retries a 429, honouring Retry-After", async () => {
        const limited = () => ({ ...problem(429, "rate_limited"), headers: { "retry-after": "7" } });
        const { vojo, sent, delays } = scripted([limited(), ok({ id: "s1" })]);
        await vojo.screens.update("s1", {} as never);
        assert.equal(sent.length, 2);
        assert.deepEqual(delays, [7000]);
    });

    it("Retry-After above 60s goes back to the caller", async () => {
        const { vojo, sent, delays } = scripted([{ ...problem(429, "rate_limited"), headers: { "retry-after": "61" } }]);
        const error = await vojo.screens.retrieve("s1").catch((e: unknown) => e);
        assert.ok(error instanceof VojoRateLimitError);
        assert.equal(error.retryAfter, 61);
        assert.equal(sent.length, 1);
        assert.deepEqual(delays, []);
    });

    it("Retry-After of exactly 60s is waited for", async () => {
        const { vojo, delays } = scripted([{ ...problem(429, "rate_limited"), headers: { "retry-after": "60" } }, ok({ id: "s1" })]);
        await vojo.screens.retrieve("s1");
        assert.deepEqual(delays, [60000]);
    });

    it("backs off exponentially with jitter, capped", async () => {
        const failures = Array.from({ length: 6 }, () => problem(500, "internal_error"));
        const { vojo, delays } = scripted([...failures, ok({ id: "s1" })], { maxRetries: 6 });
        await vojo.screens.retrieve("s1");
        for (const [i, base] of [500, 1000, 2000, 4000, 8000, 8000].entries()) {
            const delay = delays[i] as number;
            assert.ok(delay >= base * 0.75 && delay <= base, `retry ${i}: ${delay}`);
        }
    });

    it("409 in progress is retried on a keyed create, with the same key", async () => {
        const { vojo, sent } = scripted([problem(409, "idempotency_request_in_progress"), ok({ id: "st1" }, 201)]);
        await vojo.sites.create(site);
        assert.equal(sent.length, 2);
        assert.equal(sent[0]?.headers.get("idempotency-key"), sent[1]?.headers.get("idempotency-key"));
    });

    it("other conflicts are not retried", async () => {
        const { vojo, sent } = scripted([problem(409, "duplicate_name")]);
        await assert.rejects(vojo.sites.create(site), VojoConflictError);
        assert.equal(sent.length, 1);
    });

    it("other 4xx are not retried", async () => {
        for (const status of [400, 401, 403, 404, 422]) {
            const { vojo, sent } = scripted([problem(status, "x")]);
            await assert.rejects(vojo.screens.retrieve("s1"));
            assert.equal(sent.length, 1, String(status));
        }
    });
});

describe("idempotency", () => {
    it("generates one UUID per call and reuses it across retries", async () => {
        const { vojo, sent } = scripted([problem(500, "internal_error"), connectionError("ECONNRESET"), ok({ id: "st1" }, 201)]);
        await vojo.sites.create(site);
        const keys = new Set(sent.map((request) => request.headers.get("idempotency-key")));
        assert.equal(keys.size, 1);
        assert.match([...keys][0] as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("gives each call its own key", async () => {
        const { vojo, sent } = scripted([ok({ id: "1" }, 201), ok({ id: "2" }, 201)]);
        await vojo.sites.create(site);
        await vojo.sites.create(site);
        assert.notEqual(sent[0]?.headers.get("idempotency-key"), sent[1]?.headers.get("idempotency-key"));
    });

    it("uses the caller's key across retries", async () => {
        const { vojo, sent } = scripted([problem(500, "internal_error"), ok({ id: "st1" }, 201)]);
        await vojo.sites.create(site, { idempotencyKey: "my-own-key-123" });
        assert.deepEqual(sent.map((request) => request.headers.get("idempotency-key")), ["my-own-key-123", "my-own-key-123"]);
    });

    it("sends no key where the contract does not accept one", async () => {
        const { vojo, sent } = scripted([ok({ id: "e1" }), ok({ id: "s1" }), ok({ id: "s1" })]);
        await vojo.webhookEndpoints.rollSecret("e1");
        await vojo.screens.retrieve("s1");
        await vojo.screens.update("s1", {} as never);
        for (const request of sent) assert.equal(request.headers.has("idempotency-key"), false);
    });

    it("reports a replay", async () => {
        const { vojo } = scripted([ok({ id: "st1" }, 201, { "idempotent-replayed": "true" })]);
        assert.equal((await vojo.sites.create(site)).lastResponse.idempotentReplayed, true);
    });
});

describe("timeouts", () => {
    const hanging = (async (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
            if (init.signal?.aborted) reject(init.signal.reason);
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as unknown as typeof globalThis.fetch;
    const client = () => new VojoResources(new Transport({ apiKey: TEST_KEY, baseUrl: "https://api.example.test", fetch: hanging, maxRetries: 0, timeout: 10 }));

    it("raises a timeout error", async () => {
        await assert.rejects(client().screens.retrieve("s1"), VojoTimeoutError);
    });

    it("per-request timeout wins", async () => {
        await assert.rejects(client().screens.retrieve("s1", { timeout: 1 }), /timed out after 1ms/);
    });

    it("a timed-out PATCH is not retried, a timed-out GET is", async () => {
        let calls = 0;
        const counting = (async (url: string, init: RequestInit) => {
            calls++;
            return (hanging as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init);
        }) as unknown as typeof globalThis.fetch;
        const vojo = new VojoResources(
            new Transport({ apiKey: TEST_KEY, baseUrl: "https://api.example.test", fetch: counting, timeout: 5, maxRetries: 1, sleep: async () => {} })
        );
        await assert.rejects(vojo.screens.update("s1", {} as never), VojoTimeoutError);
        assert.equal(calls, 1);
        calls = 0;
        await assert.rejects(vojo.screens.retrieve("s1"), VojoTimeoutError);
        assert.equal(calls, 2);
    });

    it("a caller's abort is not retried and keeps its reason", async () => {
        const controller = new AbortController();
        const reason = new Error("stop");
        controller.abort(reason);
        await assert.rejects(client().screens.retrieve("s1", { signal: controller.signal, maxRetries: 3 }), reason);
    });
});

describe("Retry-After", () => {
    const after = (value: string, status = 429) => {
        const reply = problem(status, status === 429 ? "rate_limited" : "internal_error");
        return { ...reply, headers: { ...reply.headers, "retry-after": value } };
    };

    for (const [name, reply] of [
        ["503", after("3600", 503)],
        ["429", after("3600")],
        ["409 in progress", { ...problem(409, "idempotency_request_in_progress"), headers: { "retry-after": "3600" } }],
    ] as const) {
        it(`above 60s on a ${name} goes back to the caller without waiting`, async () => {
            const { vojo, sent, delays } = scripted([reply]);
            await assert.rejects(vojo.sites.create(site));
            assert.equal(sent.length, 1);
            assert.deepEqual(delays, []);
        });
    }

    for (const [value, ms] of [["0", 0], ["2.5", 2500], [" 3 ", 3000], ["60", 60_000]] as const) {
        it(`"${value}" waits ${ms}ms`, async () => {
            const { vojo, delays } = scripted([after(value), ok({ id: "s1" })]);
            await vojo.screens.retrieve("s1");
            assert.deepEqual(delays, [ms]);
        });
    }

    for (const value of ["", "   ", "-1", "1e3", "Infinity", "NaN", "0x10", "1.", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
        it(`"${value}" is treated as not given`, async () => {
            const { vojo, delays } = scripted([after(value), ok({ id: "s1" })]);
            await vojo.screens.retrieve("s1");
            assert.ok(delays[0]! >= 375 && delays[0]! <= 500, `waited ${delays[0]}ms`);
        });
    }

    it("digits too long for a number are longer than 60s", async () => {
        const { vojo, sent } = scripted([after("9".repeat(400))]);
        await assert.rejects(vojo.screens.retrieve("s1"), VojoRateLimitError);
        assert.equal(sent.length, 1);
    });

    it("retryAfter on the error follows the same rule", async () => {
        const seen = async (value: string) => {
            const { vojo } = scripted([after(value)], { maxRetries: 0 });
            return ((await vojo.screens.retrieve("s1").catch((error: unknown) => error)) as VojoRateLimitError).retryAfter;
        };
        assert.equal(await seen("2.5"), 2.5);
        assert.equal(await seen(""), undefined);
        assert.equal(await seen("-1"), undefined);
    });
});

describe("cancelling during a retry wait", () => {
    const transport = (fetch: typeof globalThis.fetch) => new VojoResources(new Transport({ apiKey: TEST_KEY, baseUrl: "https://api.example.test", fetch }));
    const limited = () => new Response(null, { status: 429, headers: { "retry-after": "60" } });

    it("stops at once with the signal's reason", async () => {
        let calls = 0;
        const vojo = transport((async () => {
            calls++;
            return limited();
        }) as never);
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(new Error("changed my mind")), 20);
        await assert.rejects(vojo.screens.retrieve("s1", { signal: controller.signal }), /changed my mind/);
        assert.ok(Date.now() - started < 2000, "waited out the Retry-After");
        assert.equal(calls, 1);
    });

    it("stops at once during the backoff after a dropped connection", async () => {
        let calls = 0;
        const vojo = transport((async () => {
            calls++;
            throw connectionError("ECONNRESET");
        }) as never);
        const controller = new AbortController();
        const reason = new Error("changed my mind");
        const started = Date.now();
        setTimeout(() => controller.abort(reason), 10);
        // The first backoff is at least 375ms, so a quick rejection means the wait was cut short.
        await assert.rejects(vojo.screens.retrieve("s1", { signal: controller.signal }), (error) => error === reason);
        assert.ok(Date.now() - started < 300, `waited ${Date.now() - started}ms`);
        assert.equal(calls, 1);
    });

    it("sends nothing once aborted, even when the wait ignores the signal", async () => {
        let calls = 0;
        const controller = new AbortController();
        const reason = new Error("gone");
        const vojo = new VojoResources(
            new Transport({
                apiKey: TEST_KEY,
                baseUrl: "https://api.example.test",
                fetch: (async () => {
                    calls++;
                    controller.abort(reason);
                    return limited();
                }) as never,
                sleep: async () => {},
            })
        );
        await assert.rejects(vojo.screens.retrieve("s1", { signal: controller.signal }), (error) => error === reason);
        assert.equal(calls, 1);
    });

    it("an already-aborted signal never calls fetch", async () => {
        let calls = 0;
        const vojo = transport((async () => {
            calls++;
            return limited();
        }) as never);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(vojo.screens.retrieve("s1", { signal: controller.signal }), (error) => error === controller.signal.reason && (error as Error).name === "AbortError");
        assert.equal(calls, 0);
    });

    it("a signal aborted as the response arrives never starts the wait", async () => {
        const controller = new AbortController();
        const vojo = transport((async () => {
            controller.abort(new Error("already gone"));
            return limited();
        }) as never);
        const started = Date.now();
        await assert.rejects(vojo.screens.retrieve("s1", { signal: controller.signal }), /already gone/);
        assert.ok(Date.now() - started < 2000);
    });
});
