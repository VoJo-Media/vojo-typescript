import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Vojo, VojoPaginationError } from "../src/index";
import { TEST_KEY } from "./helpers";

type Page = { data: unknown[]; meta: Record<string, unknown> };

// A real HTTP stub, because Prism replays one fixed page and cannot page.
describe("auto-paging against a stub server", () => {
    let server: Server;
    let script: Map<string, Page>;
    let requests: string[];
    let vojo: Vojo;

    before(async () => {
        server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://stub");
            const cursor = url.searchParams.get("cursor") ?? "";
            requests.push(cursor);
            const page = script.get(cursor);
            res.statusCode = page ? 200 : 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(page ?? { code: "internal_error", title: `No page for "${cursor}"` }));
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        vojo = new Vojo(TEST_KEY, { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
    });
    after(() => server.close());

    const setup = (pages: Record<string, Page>) => {
        script = new Map(Object.entries(pages));
        requests = [];
    };
    const collect = async (query?: Parameters<Vojo["screens"]["list"]>[0]) => {
        const ids: unknown[] = [];
        for await (const screen of vojo.screens.list(query)) ids.push(screen.id);
        return ids;
    };
    const page = (ids: string[], next_cursor: string | null, has_more: unknown) => ({ data: ids.map((id) => ({ id })), meta: { next_cursor, has_more } });

    it("walks every page in order and stops", async () => {
        setup({ "": page(["a", "b"], "c2", true), c2: page(["c"], "c3", true), c3: page(["d"], null, false) });
        assert.deepEqual(await collect(), ["a", "b", "c", "d"]);
        assert.deepEqual(requests, ["", "c2", "c3"]);
    });

    it("has_more false is authoritative, even with a cursor", async () => {
        setup({ "": page(["a"], "ignored", false) });
        assert.deepEqual(await collect(), ["a"]);
        assert.equal(requests.length, 1);
    });

    it("an empty-string cursor with has_more false stops", async () => {
        setup({ "": page(["a"], "", false) });
        assert.deepEqual(await collect(), ["a"]);
    });

    it("an empty-string cursor with has_more true raises", async () => {
        setup({ "": page(["a"], "", true) });
        await assert.rejects(collect(), VojoPaginationError);
    });

    it("has_more true with a null cursor raises", async () => {
        setup({ "": page(["a"], null, true) });
        await assert.rejects(collect(), /no next_cursor/);
    });

    it("a self-repeating cursor raises instead of looping", async () => {
        setup({ "": page(["a"], "c2", true), c2: page(["b"], "c2", true) });
        await assert.rejects(collect(), /Stopping instead of looping/);
        assert.deepEqual(requests, ["", "c2"]);
    });

    it("a longer cycle raises instead of looping", async () => {
        setup({ "": page(["a"], "c2", true), c2: page(["b"], "c3", true), c3: page(["c"], "c2", true) });
        await assert.rejects(collect(), VojoPaginationError);
        assert.equal(requests.length, 3);
    });

    it("a server handing back the caller's own start cursor raises", async () => {
        setup({ start: page(["a"], "start", true) });
        await assert.rejects(collect({ cursor: "start" }), VojoPaginationError);
        assert.equal(requests.length, 1);
    });

    it("treats a caller's empty cursor as no cursor", async () => {
        setup({ "": page(["a"], null, false) });
        assert.deepEqual(await collect({ cursor: "" }), ["a"]);
    });

    it("sends filters on every page", async () => {
        setup({ "": page(["a"], "c2", true), c2: page(["b"], null, false) });
        const seen: string[] = [];
        const spy = (req: { url?: string }) => seen.push(req.url ?? "");
        server.prependListener("request", spy);
        await collect({ site_id: "st1", limit: 2 });
        server.removeListener("request", spy);
        assert.ok(seen.every((url) => url.includes("site_id=st1") && url.includes("limit=2")), seen.join(" "));
    });

    it("await gives the first page and its metadata", async () => {
        setup({ "": page(["a"], "c2", true) });
        const first = await vojo.screens.list();
        assert.equal(first.data.length, 1);
        assert.deepEqual(first.meta, { next_cursor: "c2", has_more: true });
        assert.equal(first.lastResponse.status, 200);
        assert.equal(requests.length, 1);
    });

    it("sends nothing until used, and does not fetch the first page twice", async () => {
        setup({ "": page(["a"], null, false) });
        const list = vojo.screens.list();
        assert.equal(requests.length, 0);
        await list;
        const ids: unknown[] = [];
        for await (const screen of list) ids.push(screen.id);
        assert.deepEqual(ids, ["a"]);
        assert.equal(requests.length, 1);
    });

    it("fetches later pages lazily", async () => {
        setup({ "": page(["a", "b"], "c2", true), c2: page(["c"], null, false) });
        for await (const screen of vojo.screens.list()) {
            assert.equal(screen.id, "a");
            break;
        }
        assert.deepEqual(requests, [""]);
    });

    it("toArray stops at its limit", async () => {
        setup({ "": page(["a", "b"], "c2", true), c2: page(["c"], "c3", true) });
        const items = await vojo.screens.list().toArray({ limit: 3 });
        assert.equal(items.length, 3);
        assert.deepEqual(requests, ["", "c2"]);
    });

    it("an error on a later page reaches the caller", async () => {
        setup({ "": page(["a"], "missing", true) });
        await assert.rejects(collect(), /No page for "missing"/);
    });

    it("nested lists page too", async () => {
        setup({ "": page(["e1"], "c2", true), c2: page(["e2"], null, false) });
        const ids: unknown[] = [];
        for await (const event of vojo.plays.events.list("p1")) ids.push((event as { id: unknown }).id);
        assert.deepEqual(ids, ["e1", "e2"]);
    });
});
