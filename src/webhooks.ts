import { createHmac, timingSafeEqual } from "node:crypto";
import { VojoError, VojoWebhookVerificationError } from "./errors";
import type { WebhookEvent } from "./generated/events";

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const MAX_TOLERANCE_SECONDS = 86_400;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export type RawBody = string | Uint8Array;
export type VerifyOptions = {
    /** Largest allowed gap between the delivery's timestamp and now, in seconds. At most one day. */
    tolerance?: number;
    /** Current time in unix seconds. For tests. */
    now?: number;
};

const toBytes = (rawBody: RawBody): Buffer => {
    if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
    if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
    throw new VojoError(
        "Webhook body must be the raw request body as a string or Buffer, not a parsed object: the signature covers the exact bytes Vojo sent. In Express, use express.raw({ type: \"application/json\" }) on this route."
    );
};

const hmacHex = (secret: string, timestamp: string, body: Buffer): string =>
    createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(body).digest("hex");

const parseHeader = (header: string): { timestamp: string; signatures: string[] } => {
    const timestamps: string[] = [];
    const signatures: string[] = [];
    for (const part of header.split(",")) {
        const trimmed = part.trim();
        const equals = trimmed.indexOf("=");
        const scheme = equals === -1 ? trimmed : trimmed.slice(0, equals);
        const value = equals === -1 ? "" : trimmed.slice(equals + 1);
        if (scheme === "t") timestamps.push(value);
        if (scheme === "v1") signatures.push(value);
    }
    const [timestamp] = timestamps;
    if (timestamps.length !== 1 || !timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
        throw new VojoWebhookVerificationError("malformed_header", "X-Vojo-Signature is not in the form t=<unix seconds>,v1=<hex>.");
    }
    return { timestamp, signatures };
};

/**
 * Checks a delivery's signature and timestamp, and throws
 * VojoWebhookVerificationError if either fails. Any `v1` matching any secret
 * passes: during a secret roll a delivery carries one signature per secret.
 */
export const verifySignature = (
    rawBody: RawBody,
    header: string | string[] | null | undefined,
    secret: string | string[],
    options: VerifyOptions = {}
): void => {
    const body = toBytes(rawBody);
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > MAX_TOLERANCE_SECONDS) {
        throw new VojoError(`Webhook tolerance must be above 0 and at most ${MAX_TOLERANCE_SECONDS} seconds. The timestamp check cannot be turned off.`);
    }
    const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
    if (secrets.length === 0) throw new VojoError("A webhook signing secret is required.");

    const value = Array.isArray(header) ? header.join(",") : header;
    if (!value) {
        throw new VojoWebhookVerificationError(
            "missing_header",
            "The X-Vojo-Signature header is missing. An endpoint whose secret predates signing sends no signature until its secret is rolled."
        );
    }

    const { timestamp, signatures } = parseHeader(value);
    let matched = false;
    for (const key of secrets) {
        const expected = Buffer.from(hmacHex(key, timestamp, body), "utf8");
        for (const signature of signatures) {
            if (!SIGNATURE_PATTERN.test(signature)) continue;
            matched = timingSafeEqual(expected, Buffer.from(signature, "utf8")) || matched;
        }
    }
    if (!matched) {
        throw new VojoWebhookVerificationError(
            "no_matching_signature",
            "No signature matches. Check the signing secret, and pass the raw body rather than re-serialised JSON."
        );
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > tolerance) {
        throw new VojoWebhookVerificationError(
            "timestamp_out_of_tolerance",
            `The delivery's timestamp is more than ${tolerance} seconds from now. Check this machine's clock, or this may be a replay.`
        );
    }
};

const invalidPayload = (detail: string, cause?: unknown): VojoWebhookVerificationError => {
    const error = new VojoWebhookVerificationError("invalid_payload", `The signature is valid but ${detail}.`);
    if (cause) error.cause = cause;
    return error;
};

/**
 * Verifies a delivery and returns its event. Switch on `event.type`, and keep a
 * default branch: new event types can arrive without a new SDK. Dedupe on
 * `event.id`, which stays the same across retries.
 */
export const constructEvent = (
    rawBody: RawBody,
    header: string | string[] | null | undefined,
    secret: string | string[],
    options?: VerifyOptions
): WebhookEvent => {
    verifySignature(rawBody, header, secret, options);

    let payload: unknown;
    try {
        payload = JSON.parse(toBytes(rawBody).toString("utf8"));
    } catch (cause) {
        throw invalidPayload("the body is not JSON", cause);
    }
    if (!payload || typeof payload !== "object") throw invalidPayload("the body is not a JSON object");

    const fields = payload as Record<string, unknown>;
    const type = fields.eventType ?? fields.event_type;
    if (typeof type !== "string") throw invalidPayload("the body has no event type");
    const id = fields.eventId ?? fields.event_id;
    const attemptId = fields.attemptId ?? fields.attempt_id;
    return { type, id, attempt_id: attemptId ?? null, payload } as WebhookEvent;
};

/** Builds a valid X-Vojo-Signature value, for testing your own webhook handler. */
export const generateTestHeader = ({
    payload,
    secret,
    timestamp = Math.floor(Date.now() / 1000),
}: {
    payload: RawBody;
    secret: string | string[];
    timestamp?: number;
}): string => {
    const signatures = (Array.isArray(secret) ? secret : [secret]).map((key) => `v1=${hmacHex(key, String(timestamp), toBytes(payload))}`);
    return [`t=${timestamp}`, ...signatures].join(",");
};

export const webhooks = { constructEvent, verifySignature, generateTestHeader };
