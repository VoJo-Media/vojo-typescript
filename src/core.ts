import { randomUUID } from "node:crypto";
import { apiErrorFor, parseRetryAfter, redactSecrets, VojoConnectionError, VojoError, VojoTimeoutError, type Problem } from "./errors";
import { API_VERSION, SDK_VERSION } from "./generated/version";

export type RequestOptions = {
    /** Your own Idempotency-Key. One is generated when the operation accepts it. */
    idempotencyKey?: string;
    /** Milliseconds per attempt. */
    timeout?: number;
    /** Retries after the first attempt. 0 turns them off. */
    maxRetries?: number;
    /** Sent as Vojo-Organisation. OAuth callers need it; secret keys do not. */
    organisation?: string;
    /** Overrides the pinned Vojo-Version for this request. */
    version?: string;
    /** Extra request headers. */
    headers?: Record<string, string>;
    signal?: AbortSignal;
};

export type TransportConfig = {
    apiKey: string;
    baseUrl: string;
    organisation?: string;
    version?: string;
    timeout?: number;
    maxRetries?: number;
    fetch?: typeof globalThis.fetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** What every result carries about the HTTP response behind it. */
export type ResponseInfo = {
    status: number;
    headers: Headers;
    requestId: string | undefined;
    apiVersion: string | undefined;
    idempotentReplayed: boolean;
    meta: Record<string, unknown>;
};

export type WithResponse<T> = T & { readonly lastResponse: ResponseInfo };

export type Operation = {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    idempotent: boolean;
    retrySafe: boolean;
    availableInEarlyAccess: boolean;
    options?: RequestOptions;
};

export const DEFAULT_BASE_URL = "https://api.vojo-media.com";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_SECONDS = 60;
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

const NOT_YET_AVAILABLE = "This operation is not available yet during early access, which may be why.";
const REDIRECTED = "The Vojo API does not redirect, so this client does not follow redirects. Check baseUrl.";

export const encodePathParam = (name: string, value: string): string => {
    if (typeof value !== "string" || value.length === 0) throw new VojoError(`${name} must be a non-empty string.`);
    return encodeURIComponent(value);
};

const backoff = (retry: number): number => {
    const delay = Math.min(BASE_DELAY_MS * 2 ** retry, MAX_DELAY_MS);
    return delay * (0.75 + Math.random() * 0.25);
};

const neverConnected = (error: unknown): boolean => {
    const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
    return typeof cause?.code === "string" && NEVER_CONNECTED.has(cause.code);
};

/** Rejects with the signal's reason as soon as it aborts, and leaves no timer behind. */
const sleepUntilAborted = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });

/** `redirected` marks a 3xx, or the status-0 `opaqueredirect` that `redirect: "manual"` gives in a browser. */
type RawResponse = { status: number; headers: Headers; text: string; redirected: boolean };

/** Sends requests and applies the retry, idempotency and error rules. Holds the secret. */
export class Transport {
    readonly #apiKey: string;
    readonly #baseUrl: string;
    readonly #organisation: string | undefined;
    readonly #version: string;
    readonly #timeout: number;
    readonly #maxRetries: number;
    readonly #fetch: typeof globalThis.fetch;
    readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

    constructor(config: TransportConfig) {
        this.#apiKey = config.apiKey;
        this.#baseUrl = config.baseUrl;
        this.#organisation = config.organisation;
        this.#version = config.version ?? API_VERSION;
        this.#timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
        this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.#fetch = config.fetch ?? globalThis.fetch;
        this.#sleep = config.sleep ?? sleepUntilAborted;
    }

    /** Sends the operation. `json` is undefined for an empty response. */
    async send(op: Operation): Promise<{ json: unknown; info: ResponseInfo }> {
        const url = this.#url(op);
        const init = this.#init(op);
        const maxRetries = op.options?.maxRetries ?? this.#maxRetries;
        const signal = op.options?.signal;

        for (let retry = 0; ; retry++) {
            let response: RawResponse;
            try {
                response = await this.#attempt(url, init, op.options);
            } catch (error) {
                if (signal?.aborted) throw error;
                const safe = op.retrySafe || neverConnected(error);
                if (retry >= maxRetries || !safe) throw this.#connectionError(error, op);
                await this.#sleep(backoff(retry), signal);
                continue;
            }

            if (response.status >= 200 && response.status < 300) return this.#success(response);

            const problem = parseProblem(response);
            const delay = this.#retryDelay(response, problem, op, retry);
            if (retry >= maxRetries || delay === undefined) throw apiErrorFor(response.status, problem, response.headers, this.#hint(response, op));
            await this.#sleep(delay, signal);
        }
    }

    /** undefined means do not retry this response. */
    #retryDelay(response: RawResponse, problem: Problem | undefined, op: Operation, retry: number): number | undefined {
        const { status, headers } = response;
        const retryable =
            status === 429 ||
            (op.retrySafe && status >= 500) ||
            (op.idempotent && status === 409 && problem?.code === "idempotency_request_in_progress");
        if (!retryable) return undefined;

        const retryAfter = parseRetryAfter(headers.get("retry-after"));
        if (retryAfter === undefined) return backoff(retry);
        return retryAfter > MAX_RETRY_AFTER_SECONDS ? undefined : retryAfter * 1000;
    }

    #hint({ status, redirected }: RawResponse, op: Operation): string | undefined {
        if (redirected) return REDIRECTED;
        if (status === 404 && !op.availableInEarlyAccess) return NOT_YET_AVAILABLE;
        return undefined;
    }

    #connectionError(error: unknown, op: Operation): VojoError {
        const options = { cause: error };
        if (error instanceof DOMException && error.name === "TimeoutError") {
            return new VojoTimeoutError(`${op.method} ${op.path} timed out after ${op.options?.timeout ?? this.#timeout}ms.`, options);
        }
        const reason = error instanceof Error ? redactSecrets(error.message) : "unknown error";
        const detail = (error as { cause?: { message?: unknown } } | undefined)?.cause?.message;
        const suffix = typeof detail === "string" ? ` (${detail})` : "";
        return new VojoConnectionError(`Could not reach the Vojo API for ${op.method} ${op.path}: ${reason}${suffix}`, options);
    }

    async #attempt(url: string, init: RequestInit, options: RequestOptions | undefined): Promise<RawResponse> {
        const timeout = options?.timeout ?? this.#timeout;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeout);
        const caller = options?.signal;
        const forward = () => controller.abort(caller?.reason);
        // A cancelled call sends nothing more, even through an injected fetch that ignores the signal.
        if (caller?.aborted) {
            clearTimeout(timer);
            throw caller.reason;
        }
        caller?.addEventListener("abort", forward, { once: true });
        try {
            const response = await this.#fetch(url, { ...init, signal: controller.signal });
            const { status, headers } = response;
            const redirected = response.type === "opaqueredirect" || (status >= 300 && status < 400);
            // Inside the try: the timeout also covers reading the body.
            return { status, headers, redirected, text: await response.text() };
        } catch (error) {
            throw controller.signal.aborted ? (controller.signal.reason ?? error) : error;
        } finally {
            clearTimeout(timer);
            caller?.removeEventListener("abort", forward);
        }
    }

    #url(op: Operation): string {
        const url = new URL(`${this.#baseUrl}${op.path}`);
        for (const [name, value] of Object.entries(op.query ?? {})) {
            if (value === undefined || value === null) continue;
            for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
        }
        return url.toString();
    }

    #init(op: Operation): RequestInit {
        const headers = new Headers({
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: "application/json, application/problem+json",
            "User-Agent": `vojo-typescript/${SDK_VERSION}`,
            "Vojo-Version": op.options?.version ?? this.#version,
        });
        const organisation = op.options?.organisation ?? this.#organisation;
        if (organisation) headers.set("Vojo-Organisation", organisation);
        if (op.body !== undefined) headers.set("Content-Type", "application/json");
        // Created once here, so every retry of this call sends the same key.
        if (op.idempotent) headers.set("Idempotency-Key", op.options?.idempotencyKey ?? randomUUID());
        for (const [name, value] of Object.entries(op.options?.headers ?? {})) headers.set(name, value);
        // Following a redirect can turn a POST into a GET that looks like a success.
        return { method: op.method, headers, redirect: "manual", ...(op.body !== undefined && { body: JSON.stringify(op.body) }) };
    }

    #success({ status, headers, text }: RawResponse): { json: unknown; info: ResponseInfo } {
        const json = text ? parseJson(text, status, headers) : undefined;
        const meta = (json as { meta?: Record<string, unknown> } | undefined)?.meta ?? {};
        return {
            json,
            info: {
                status,
                headers,
                meta,
                requestId: headers.get("vojo-request-id") ?? undefined,
                apiVersion: headers.get("vojo-version") ?? undefined,
                idempotentReplayed: headers.get("idempotent-replayed") === "true",
            },
        };
    }
}

const parseJson = (text: string, status: number, headers: Headers): unknown => {
    try {
        return JSON.parse(text);
    } catch (cause) {
        const requestId = headers.get("vojo-request-id");
        const suffix = requestId ? ` Request id: ${requestId}.` : "";
        throw new VojoError(`The Vojo API returned status ${status} with a body that is not JSON.${suffix}`, { cause });
    }
};

// A proxy can answer with an HTML page, so a bad body is just "no problem document".
const parseProblem = ({ text }: RawResponse): Problem | undefined => {
    try {
        const parsed: unknown = JSON.parse(redactSecrets(text));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Problem) : undefined;
    } catch {
        return undefined;
    }
};

const withResponse = <T>(value: T, info: ResponseInfo): WithResponse<T> => {
    if (value && typeof value === "object") {
        Object.defineProperty(value, "lastResponse", { value: info, enumerable: false });
    }
    return value as WithResponse<T>;
};

/** Returns the contents of `data`. */
export const sendForData = async <T>(transport: Transport, op: Operation): Promise<WithResponse<T>> => {
    const { json, info } = await transport.send(op);
    return withResponse((json as { data: T }).data, info);
};

/** Returns `data` and `meta`, for operations where `meta` carries information. */
export const sendForEnvelope = async <T>(transport: Transport, op: Operation): Promise<WithResponse<T>> => {
    const { json, info } = await transport.send(op);
    return withResponse(json as T, info);
};

export const sendForVoid = async (transport: Transport, op: Operation): Promise<void> => {
    await transport.send(op);
};
