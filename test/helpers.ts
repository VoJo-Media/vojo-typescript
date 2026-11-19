import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transport } from "../src/core";
import { VojoResources } from "../src/generated/resources";

const here = dirname(fileURLToPath(import.meta.url));
const packaged = join(here, "../shared");
export const sharedDir = existsSync(packaged) ? packaged : resolve(here, "../../shared");
export const readShared = (name: string) => JSON.parse(readFileSync(join(sharedDir, name), "utf8"));

export const TEST_KEY = "vojo_live_not_a_real_key";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
export type Sent = { url: URL; method: string; headers: Headers; body: string | undefined };

/** A client whose HTTP replies are scripted, and whose retry delays are recorded rather than slept. */
export const scripted = (replies: Reply[], { maxRetries }: { maxRetries?: number } = {}) => {
    const sent: Sent[] = [];
    const delays: number[] = [];
    const queue = [...replies];
    const fakeFetch = (async (input: string, init: RequestInit) => {
        sent.push({ url: new URL(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body as string | undefined });
        const reply = queue.shift();
        if (!reply) throw new Error("The test ran out of scripted replies");
        if (reply instanceof Error) throw reply;
        const text = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        return new Response(text, { status: reply.status, ...(reply.headers && { headers: reply.headers }) });
    }) as unknown as typeof globalThis.fetch;

    const transport = new Transport({
        apiKey: TEST_KEY,
        baseUrl: "https://api.example.test",
        fetch: fakeFetch,
        sleep: async (ms) => {
            delays.push(ms);
        },
        ...(maxRetries !== undefined && { maxRetries }),
    });
    return { vojo: new VojoResources(transport), sent, delays };
};

export const connectionError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

export const problem = (status: number, code: string, detail = "It went wrong.", extra: object = {}) => ({
    status,
    body: { type: `https://docs.example.test/${code}`, title: code, status, code, detail, request_id: "req_123", ...extra },
    headers: { "content-type": "application/problem+json", "vojo-request-id": "req_123" },
});

export const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => ({ status, body: { data, meta: {} }, headers });
