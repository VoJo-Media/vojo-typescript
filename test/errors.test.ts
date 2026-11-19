import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import {
    Vojo,
    VojoAPIError,
    VojoAuthenticationError,
    VojoConflictError,
    VojoConnectionError,
    VojoNotFoundError,
    VojoPermissionError,
    VojoRateLimitError,
    VojoServerError,
    VojoValidationError,
} from "../src/index";
import { redactSecrets } from "../src/errors";
import { Transport } from "../src/core";
import { VojoResources } from "../src/generated/resources";
import { problem, scripted, TEST_KEY } from "./helpers";

const RESERVED_PREFIX = ["vojo", "test", ""].join("_");

const failing = async (reply: Parameters<typeof scripted>[0][number]) => {
    const { vojo } = scripted([reply], { maxRetries: 0 });
    return (await vojo.sites.create({} as never).catch((error: unknown) => error)) as VojoAPIError;
};

describe("error mapping", () => {
    const table: [number, string, typeof VojoAPIError][] = [
        [400, "invalid_request", VojoValidationError],
        [401, "invalid_token", VojoAuthenticationError],
        [402, "entitlement_limit_reached", VojoPermissionError],
        [403, "insufficient_scope", VojoPermissionError],
        [404, "not_found", VojoNotFoundError],
        [409, "duplicate_name", VojoConflictError],
        [413, "payload_too_large", VojoValidationError],
        [422, "validation_failed", VojoValidationError],
        [429, "rate_limited", VojoRateLimitError],
        [500, "internal_error", VojoServerError],
        [503, "internal_error", VojoServerError],
    ];

    for (const [status, code, kind] of table) {
        it(`${status} ${code} is ${kind.name}`, async () => {
            const error = await failing(problem(status, code, "Why it failed."));
            assert.ok(error instanceof kind);
            assert.equal(error.name, kind.name);
            assert.equal(error.status, status);
            assert.equal(error.code, code);
            assert.equal(error.requestId, "req_123");
            assert.equal(error.problem?.code, code);
            assert.equal(error.message, "Why it failed.");
        });
    }

    it("an unknown status falls back to the base class", async () => {
        const error = await failing(problem(418, "teapot"));
        assert.equal(error.constructor, VojoAPIError);
    });

    it("an unknown code is classified by status", async () => {
        const error = await failing(problem(422, "code_from_the_future"));
        assert.ok(error instanceof VojoValidationError);
        assert.equal(error.code, "code_from_the_future");
    });

    it("exposes field errors", async () => {
        const errors = [{ pointer: "/name", code: "required", detail: "name is required" }];
        const error = (await failing(problem(422, "validation_failed", "1 field failed.", { errors }))) as VojoValidationError;
        assert.deepEqual(error.fieldErrors, errors);
    });

    it("keeps plan-limit members in the problem", async () => {
        const error = await failing(problem(402, "entitlement_limit_reached", "Limit.", { feature_key: "dashboards.author", limit: 3, used: 3 }));
        assert.equal(error.problem?.feature_key, "dashboards.author");
    });

    it("survives an HTML error page from a proxy", async () => {
        const error = await failing({ status: 502, body: "<html>Bad gateway</html>", headers: { "vojo-request-id": "req_9" } });
        assert.ok(error instanceof VojoServerError);
        assert.equal(error.problem, undefined);
        assert.equal(error.code, undefined);
        assert.equal(error.requestId, "req_9");
        assert.match(error.message, /status 502/);
    });

    it("falls back to the title when there is no detail", async () => {
        const error = await failing({ status: 404, body: { title: "Not found", code: "not_found" } });
        assert.match(error.message, /^Not found/);
    });

    it("a successful non-JSON body is a clear error, not a parse crash", async () => {
        const { vojo } = scripted([{ status: 200, body: "<html>" }]);
        await assert.rejects(vojo.screens.retrieve("s1"), /not JSON/);
    });
});

describe("hints", () => {
    it("a 404 on an operation not served yet says so", async () => {
        const { vojo } = scripted([problem(404, "not_found", "Not found.")]);
        await assert.rejects(vojo.sites.retrieve("s1"), /not available yet during early access/);
    });

    it("a 404 on a served operation does not", async () => {
        const { vojo } = scripted([problem(404, "not_found", "Not found.")]);
        const error = (await vojo.screens.retrieve("s1").catch((e: unknown) => e)) as Error;
        assert.equal(error.message, "Not found.");
    });

    it("a 401 on a test key adds no hint: the API answers a wrong-mode key like any invalid one", async () => {
        const fake = (async () => new Response(JSON.stringify({ code: "invalid_token", detail: "Invalid." }), { status: 401 })) as unknown as typeof fetch;
        const vojo = new VojoResources(new Transport({ apiKey: `${RESERVED_PREFIX}abc`, baseUrl: "https://api.example.test", fetch: fake }));
        const error = (await vojo.screens.retrieve("s1").catch((e: unknown) => e)) as Error;
        assert.equal(error.message, "Invalid.");
    });
});

describe("secrets never leak", () => {
    it("the client's printed form does not contain the key", () => {
        const vojo = new Vojo(TEST_KEY);
        for (const text of [inspect(vojo, { depth: 10, showHidden: true }), JSON.stringify(vojo), String(vojo)]) {
            assert.equal(text.includes(TEST_KEY), false);
        }
    });

    it("API errors do not contain the key", async () => {
        const { vojo } = scripted([problem(401, "invalid_token", `Bad key ${TEST_KEY}`)], { maxRetries: 0 });
        const error = await vojo.screens.retrieve("s1").catch((e: unknown) => e);
        assert.equal(inspect(error, { depth: 10, showHidden: true }).includes(TEST_KEY), false);
        assert.equal(JSON.stringify((error as VojoAPIError).problem).includes(TEST_KEY), false);
    });

    it("connection errors do not contain the key", async () => {
        const fake = (async () => {
            throw new TypeError(`Invalid header: Bearer ${TEST_KEY}`);
        }) as unknown as typeof fetch;
        const vojo = new VojoResources(new Transport({ apiKey: TEST_KEY, baseUrl: "https://api.example.test", fetch: fake, maxRetries: 0 }));
        const error = (await vojo.screens.retrieve("s1").catch((e: unknown) => e)) as VojoConnectionError;
        assert.ok(error instanceof VojoConnectionError);
        assert.equal(error.message.includes(TEST_KEY), false);
    });

    it("redacts both prefixes", () => {
        assert.equal(redactSecrets(`a vojo_live_abc b ${RESERVED_PREFIX}def`), `a vojo_live_[redacted] b ${RESERVED_PREFIX}[redacted]`);
    });
});

describe("field errors in the message", () => {
    const invalid = (errors: unknown, status = 422) => failing(problem(status, "validation_failed", "2 fields failed validation.", { errors }));

    it("names the pointer, code and detail", async () => {
        const error = await invalid([
            { pointer: "/name", code: "required", detail: "Name is required" },
            { pointer: "/limit", code: "too_large", detail: "Too large" },
        ]);
        assert.equal(error.message, "2 fields failed validation. /name (required): Name is required; /limit (too_large): Too large");
    });

    it("lists five, then says how many more", async () => {
        const errors = Array.from({ length: 8 }, (_, i) => ({ pointer: `/f${i}`, code: "bad", detail: "Bad" }));
        const error = (await invalid(errors)) as VojoValidationError;
        assert.ok(error.message.includes("/f4 (bad): Bad; and 3 more"), error.message);
        assert.ok(!error.message.includes("/f5"), error.message);
        assert.equal(error.fieldErrors.length, 8);
    });

    it("leaves out missing parts and skips what is not a field error", async () => {
        const error = await invalid([{ detail: "Only a detail" }, { pointer: "/a" }, { code: "c", detail: "d" }, "junk", null, {}]);
        assert.equal(error.message, "2 fields failed validation. Only a detail; /a; (c): d");
    });

    it("counts only non-empty strings as parts", async () => {
        const error = await invalid([
            { pointer: "/a", code: 7, detail: { nested: true } },
            { pointer: "", code: "c", detail: 42 },
            { pointer: 1, code: null, detail: [] },
        ]);
        assert.equal(error.message, "2 fields failed validation. /a; (c)");
    });

    it("falls back past a detail or title that is not a non-empty string", async () => {
        const { vojo } = scripted([{ status: 422, body: { detail: 5, title: "" } }]);
        const error = (await vojo.screens.retrieve("s1").catch((e: unknown) => e)) as VojoAPIError;
        assert.equal(error.message, "The Vojo API returned status 422.");
    });

    it("is unchanged when errors is absent, empty or not a list", async () => {
        for (const errors of [undefined, [], "nope"]) {
            assert.equal((await invalid(errors)).message, "2 fields failed validation.");
        }
    });

    it("applies to 400 and 413 as well, and to no other kind", async () => {
        const field = [{ pointer: "/a", code: "c", detail: "d" }];
        assert.ok((await invalid(field, 400)).message.endsWith("/a (c): d"));
        assert.ok((await invalid(field, 413)).message.endsWith("/a (c): d"));
        assert.equal((await invalid(field, 409)).message, "2 fields failed validation.");
    });

    it("redacts a key echoed in a field error", async () => {
        const key = ["vojo", "live", "abc123"].join("_");
        const error = await invalid([{ pointer: "/a", code: "c", detail: `bad ${key}` }]);
        assert.ok(!error.message.includes(key), error.message);
    });
});

describe("anything but a 2xx", () => {
    for (const status of [301, 302, 304, 307, 308]) {
        it(`${status} is an error that points at the base URL`, async () => {
            const { vojo, sent } = scripted([{ status }]);
            const error = (await vojo.screens.retrieve("s1").catch((e: unknown) => e)) as VojoAPIError;
            assert.ok(error instanceof VojoAPIError);
            assert.equal(error.status, status);
            assert.match(error.message, /redirect/i);
            assert.match(error.message, /baseUrl/);
            assert.equal(sent.length, 1);
        });
    }

    it("an opaqueredirect (status 0) counts as a 3xx and points at the base URL", async () => {
        let calls = 0;
        const opaque = (async () => {
            calls++;
            return { type: "opaqueredirect", status: 0, headers: new Headers(), text: async () => "" };
        }) as unknown as typeof globalThis.fetch;
        const vojo = new VojoResources(new Transport({ apiKey: TEST_KEY, baseUrl: "https://api.example.test", fetch: opaque, sleep: async () => {} }));
        const error = (await vojo.screens.retrieve("s1").catch((e: unknown) => e)) as VojoAPIError;
        assert.ok(error instanceof VojoAPIError, String(error));
        assert.equal(error.status, 0);
        assert.match(error.message, /redirect/i);
        assert.match(error.message, /baseUrl/);
        assert.equal(calls, 1);
    });

    it("a real redirect is not followed, so a POST cannot become a GET", async () => {
        const seen: string[] = [];
        const server = createServer((request, response) => {
            seen.push(`${request.method} ${request.url}`);
            if (request.url === "/elsewhere") {
                response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "wrong" }, meta: {} }));
            } else {
                response.writeHead(302, { location: "/elsewhere" }).end();
            }
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        try {
            const { port } = server.address() as AddressInfo;
            const vojo = new Vojo(TEST_KEY, { baseUrl: `http://127.0.0.1:${port}` });
            const error = (await vojo.sites.create({ name: "n" } as never).catch((e: unknown) => e)) as VojoAPIError;
            assert.ok(error instanceof VojoAPIError, String(error));
            assert.equal(error.status, 302);
            assert.deepEqual(seen, ["POST /v1/sites"]);
        } finally {
            server.close();
        }
    });
});
