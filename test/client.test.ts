import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { API_VERSION, SDK_VERSION, Vojo, VojoError } from "../src/index";
import { ok, problem, readShared, scripted, TEST_KEY } from "./helpers";

type ManifestOp = { resource: string[]; method: string; operation_id: string };

describe("constructor", () => {
    const saved = { key: process.env.VOJO_SECRET_KEY, url: process.env.VOJO_BASE_URL };
    afterEach(() => {
        for (const [name, value] of [["VOJO_SECRET_KEY", saved.key], ["VOJO_BASE_URL", saved.url]] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it("a missing key names the variable and the way to get one", () => {
        delete process.env.VOJO_SECRET_KEY;
        assert.throws(() => new Vojo(), /VOJO_SECRET_KEY.*issued by Vojo/);
        assert.throws(() => new Vojo(""), VojoError);
        assert.throws(() => new Vojo("   "), VojoError);
    });

    it("falls back to VOJO_SECRET_KEY", () => {
        process.env.VOJO_SECRET_KEY = TEST_KEY;
        assert.ok(new Vojo());
    });

    it("refuses plain http except locally", () => {
        assert.throws(() => new Vojo(TEST_KEY, { baseUrl: "http://api.example.test" }), /https/);
        for (const baseUrl of ["http://localhost:4020", "http://127.0.0.1:4020"]) assert.ok(new Vojo(TEST_KEY, { baseUrl }));
    });

    it("rejects a malformed base URL", () => {
        assert.throws(() => new Vojo(TEST_KEY, { baseUrl: "not a url" }), /not a valid URL/);
    });

    it("refuses to run in a browser unless told to", () => {
        (globalThis as { document?: unknown }).document = {};
        try {
            assert.throws(() => new Vojo(TEST_KEY), /browser/);
            assert.ok(new Vojo(TEST_KEY, { dangerouslyAllowBrowser: true }));
        } finally {
            delete (globalThis as { document?: unknown }).document;
        }
    });
});

describe("requests", () => {
    const viaClient = async (options: ConstructorParameters<typeof Vojo>[1], call: (v: Vojo) => Promise<unknown>) => {
        const seen: { url: string; headers: Headers }[] = [];
        const fetch = (async (url: string, init: RequestInit) => {
            seen.push({ url, headers: new Headers(init.headers) });
            return new Response(JSON.stringify({ data: { id: "x" }, meta: {} }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;
        await call(new Vojo(TEST_KEY, { ...options, fetch }));
        return seen[0] as { url: string; headers: Headers };
    };

    it("sends auth, pinned version and user agent, with no org header by default", async () => {
        const { headers, url } = await viaClient({}, (v) => v.organisation.retrieve());
        assert.equal(url, "https://api.vojo-media.com/v1/organisation");
        assert.equal(headers.get("authorization"), `Bearer ${TEST_KEY}`);
        assert.equal(headers.get("vojo-version"), API_VERSION);
        assert.equal(headers.get("user-agent"), `vojo-typescript/${SDK_VERSION}`);
        assert.equal(headers.has("vojo-organisation"), false);
    });

    it("the pinned version is the contract's", () => {
        assert.equal(API_VERSION, readShared("api/operations.json").api_version);
    });

    it("version can be overridden on the client and per request", async () => {
        const client = await viaClient({ version: "2030-01-01" }, (v) => v.organisation.retrieve());
        assert.equal(client.headers.get("vojo-version"), "2030-01-01");
        const perRequest = await viaClient({ version: "2030-01-01" }, (v) => v.organisation.retrieve({ version: "2031-01-01" }));
        assert.equal(perRequest.headers.get("vojo-version"), "2031-01-01");
    });

    it("organisation can be set on the client and per request", async () => {
        const client = await viaClient({ organisation: "org_1" }, (v) => v.organisation.retrieve());
        assert.equal(client.headers.get("vojo-organisation"), "org_1");
        const perRequest = await viaClient({ organisation: "org_1" }, (v) => v.organisation.retrieve({ organisation: "org_2" }));
        assert.equal(perRequest.headers.get("vojo-organisation"), "org_2");
    });

    it("normalises a base URL with a trailing slash or /v1", async () => {
        for (const baseUrl of ["https://api.example.test/", "https://api.example.test/v1", "https://api.example.test/v1/"]) {
            const { url } = await viaClient({ baseUrl }, (v) => v.organisation.retrieve());
            assert.equal(url, "https://api.example.test/v1/organisation");
        }
    });

    it("encodes path parameters and rejects empty ones", async () => {
        const { vojo, sent } = scripted([ok({ id: "a/b" })]);
        await vojo.screens.retrieve("a/b?c");
        assert.equal(sent[0]?.url.pathname, "/v1/screens/a%2Fb%3Fc");
        await assert.rejects(async () => vojo.screens.retrieve(""), /screenId must be a non-empty string/);
    });

    it("keeps several path parameters in order", async () => {
        const { vojo, sent } = scripted([{ status: 202 }]);
        await vojo.webhookEndpoints.deliveries.retry("e1", "d1");
        assert.equal(sent[0]?.url.pathname, "/v1/webhook-endpoints/e1/deliveries/d1/retry");
    });

    it("sends JSON bodies only when there is one", async () => {
        const { vojo, sent } = scripted([ok({ id: "1" }, 201), ok({ id: "1" })]);
        await vojo.sites.create({ name: "Leeds" } as never);
        assert.equal(sent[0]?.headers.get("content-type"), "application/json");
        assert.deepEqual(JSON.parse(sent[0]?.body as string), { name: "Leeds" });
        await vojo.screens.retrieve("s1");
        assert.equal(sent[1]?.headers.has("content-type"), false);
        assert.equal(sent[1]?.body, undefined);
    });

    it("drops undefined query values", async () => {
        const { vojo, sent } = scripted([{ status: 200, body: { data: [], meta: { next_cursor: null, has_more: false } } }]);
        await vojo.screens.list({ site_id: undefined as never, has_harvester: true });
        assert.equal(sent[0]?.url.search, "?has_harvester=true");
    });

    it("merges extra headers", async () => {
        const { headers } = await viaClient({}, (v) => v.organisation.retrieve({ headers: { "X-Trace": "abc" } }));
        assert.equal(headers.get("x-trace"), "abc");
    });
});

describe("results", () => {
    it("unwraps data and keeps response details out of the way", async () => {
        const { vojo } = scripted([{ status: 200, body: { data: { id: "s1" }, meta: { note: 1 } }, headers: { "vojo-request-id": "req_1", "vojo-version": "2026-10-07" } }]);
        const screen = await vojo.screens.retrieve("s1");
        assert.deepEqual(screen, { id: "s1" });
        assert.equal(JSON.stringify(screen), '{"id":"s1"}');
        assert.equal(screen.lastResponse.requestId, "req_1");
        assert.equal(screen.lastResponse.apiVersion, "2026-10-07");
        assert.equal(screen.lastResponse.status, 200);
        assert.deepEqual(screen.lastResponse.meta, { note: 1 });
    });

    it("exposes a wrapper's warnings through meta", async () => {
        const warnings = [{ code: "screen_id_missing" }];
        const { vojo } = scripted([{ status: 201, body: { data: { id: "w1" }, meta: { warnings } } }]);
        const wrapper = await vojo.wrappers.create({} as never);
        assert.deepEqual(wrapper.lastResponse.meta.warnings, warnings);
    });

    it("returns data and meta when meta carries information", async () => {
        const { vojo } = scripted([{ status: 200, body: { data: [{ id: "i1" }], meta: { generated_at: "t" } } }]);
        const issues = await vojo.issues.list();
        assert.deepEqual(issues.data, [{ id: "i1" }]);
        assert.equal(issues.meta.generated_at, "t");
    });

    it("unwraps array data", async () => {
        const { vojo } = scripted([ok([{ id: "r1" }])]);
        const ranges = await vojo.screenSizeRanges.list();
        assert.equal(ranges[0]?.id, "r1");
        assert.equal(ranges.lastResponse.status, 200);
    });

    it("returns nothing for 204", async () => {
        const { vojo } = scripted([{ status: 204 }]);
        assert.equal(await vojo.screens.delete("s1"), undefined);
    });

    it("tolerates unknown fields", async () => {
        const { vojo } = scripted([ok({ id: "s1", added_next_year: true })]);
        assert.equal(((await vojo.screens.retrieve("s1")) as unknown as { added_next_year: boolean }).added_next_year, true);
    });

    it("surfaces a 404 from a retried DELETE", async () => {
        const { vojo } = scripted([{ status: 500, body: {} }, problem(404, "not_found")]);
        await assert.rejects(vojo.screens.delete("s1"), /It went wrong/);
    });
});

describe("generated surface", () => {
    const { operations } = readShared("api/operations.json") as { operations: ManifestOp[] };

    it("every operation in the contract has a method", () => {
        const vojo = new Vojo(TEST_KEY) as unknown as Record<string, Record<string, unknown>>;
        assert.equal(operations.length, 72);
        for (const op of operations) {
            let node: unknown = vojo;
            for (const part of op.resource) node = (node as Record<string, unknown>)[part];
            assert.equal(typeof (node as Record<string, unknown>)[op.method], "function", op.operation_id);
        }
    });
});
