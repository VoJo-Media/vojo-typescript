import { DEFAULT_BASE_URL, Transport, type TransportConfig } from "./core";
import { VojoError } from "./errors";
import { VojoResources } from "./generated/resources";
import { webhooks } from "./webhooks";

export type VojoOptions = {
    /** Defaults to VOJO_BASE_URL, then the production API. */
    baseUrl?: string;
    /** Sent as Vojo-Organisation. OAuth callers need it; secret keys are bound to one organisation. */
    organisation?: string;
    /** Overrides the API version this SDK was generated against. */
    version?: string;
    /** Milliseconds per attempt. Default 60000. */
    timeout?: number;
    /** Retries after the first attempt. Default 2. */
    maxRetries?: number;
    fetch?: typeof globalThis.fetch;
    /** Secret keys must stay on a server. Set this only if you truly hold a token that is safe in a browser. */
    dangerouslyAllowBrowser?: boolean;
};

const fromEnv = (name: string): string | undefined => (typeof process === "undefined" ? undefined : process.env?.[name]);

const normaliseBaseUrl = (raw: string): string => {
    const trimmed = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new VojoError(`baseUrl is not a valid URL: ${raw}`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new VojoError("baseUrl must use https, so your key is never sent in the clear.");
    return trimmed;
};

export class Vojo extends VojoResources {
    /** Webhook verification, which needs no API key: `Vojo.webhooks.constructEvent(…)`. */
    static readonly webhooks = webhooks;
    readonly webhooks = webhooks;

    constructor(apiKey?: string | null, options: VojoOptions = {}) {
        const key = (apiKey ?? fromEnv("VOJO_SECRET_KEY") ?? "").trim();
        if (!key) {
            throw new VojoError(
                "No API key. Pass one to new Vojo(key) or set VOJO_SECRET_KEY. Keys are issued by Vojo during early access. To verify webhooks without a key, use `webhooks` from this package."
            );
        }
        if (typeof document !== "undefined" && !options.dangerouslyAllowBrowser) {
            throw new VojoError("This looks like a browser. A Vojo secret key must stay on your server, because anyone can read it from a page.");
        }
        const config: TransportConfig = {
            apiKey: key,
            baseUrl: normaliseBaseUrl(options.baseUrl ?? fromEnv("VOJO_BASE_URL") ?? DEFAULT_BASE_URL),
            ...(options.organisation !== undefined && { organisation: options.organisation }),
            ...(options.version !== undefined && { version: options.version }),
            ...(options.timeout !== undefined && { timeout: options.timeout }),
            ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
            ...(options.fetch !== undefined && { fetch: options.fetch }),
        };
        super(new Transport(config));
    }
}
