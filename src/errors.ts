/** Base class for every error this library raises. */
export class VojoError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(redactSecrets(message), options);
        this.name = new.target.name;
    }
}

const SECRET_KEY_PATTERN = /vojo_(live|test)_\w+/g;

/** Removes anything shaped like a secret key, so it cannot reach a log through an error. */
export const redactSecrets = (text: string): string => text.replace(SECRET_KEY_PATTERN, "vojo_$1_[redacted]");

/** An RFC 9457 problem document from the API. Unknown members are kept. */
export type Problem = {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    instance?: string;
    code?: string;
    request_id?: string;
    errors?: FieldError[];
    [member: string]: unknown;
};

export type FieldError = { pointer?: string; code?: string; detail?: string };

const MOST_FIELD_ERRORS_IN_MESSAGE = 5;
const RETRY_AFTER_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

/** Seconds from a Retry-After header. Undefined when it is absent or anything but a plain number of seconds. */
export const parseRetryAfter = (value: string | null | undefined): number | undefined => {
    const trimmed = value?.trim();
    return trimmed && RETRY_AFTER_PATTERN.test(trimmed) ? Number(trimmed) : undefined;
};

/** Only a non-empty string counts; a number, object or anything else is missing. */
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

const describeFieldError = (error: unknown): string => {
    if (!error || typeof error !== "object") return "";
    const { pointer, code, detail } = error as Record<string, unknown>;
    const codePart = text(code);
    const where = [text(pointer), codePart && `(${codePart})`].filter(Boolean).join(" ");
    return [where, text(detail)].filter(Boolean).join(": ");
};

const describeFieldErrors = (errors: unknown): string | undefined => {
    if (!Array.isArray(errors)) return undefined;
    const described = errors.map(describeFieldError).filter(Boolean);
    const listed = described.slice(0, MOST_FIELD_ERRORS_IN_MESSAGE);
    if (described.length > listed.length) listed.push(`and ${described.length - listed.length} more`);
    return listed.join("; ") || undefined;
};

/**
 * The API answered with an error status. Branch on `code`, or on the subclass:
 * the API can add new codes, so handle an unknown `code` by its class.
 */
export class VojoAPIError extends VojoError {
    readonly status: number;
    readonly code: string | undefined;
    readonly problem: Problem | undefined;
    readonly requestId: string | undefined;
    readonly headers: Headers;

    constructor(status: number, problem: Problem | undefined, headers: Headers, hint?: string) {
        const summary = text(problem?.detail) ?? text(problem?.title) ?? `The Vojo API returned status ${status}.`;
        super(hint ? `${summary} ${hint}` : summary);
        this.status = status;
        this.problem = problem;
        this.code = problem?.code;
        this.headers = headers;
        this.requestId = problem?.request_id ?? headers.get("vojo-request-id") ?? undefined;
    }
}

/** 401: the key or token is missing, invalid, expired or revoked. */
export class VojoAuthenticationError extends VojoAPIError {}
/** 402 or 403: the key lacks a scope or permission, or a plan limit was reached. */
export class VojoPermissionError extends VojoAPIError {}
/** 404: it does not exist, or it belongs to another organisation. */
export class VojoNotFoundError extends VojoAPIError {}
/** 409: a conflict with existing state, or an Idempotency-Key problem. */
export class VojoConflictError extends VojoAPIError {}
/** 5xx: something went wrong on Vojo's side. */
export class VojoServerError extends VojoAPIError {}

/** 400, 413 or 422: the request was rejected. See `fieldErrors`. */
export class VojoValidationError extends VojoAPIError {
    constructor(status: number, problem: Problem | undefined, headers: Headers, hint?: string) {
        const fields = describeFieldErrors(problem?.errors);
        super(status, problem, headers, [fields, hint].filter(Boolean).join(" ") || undefined);
    }

    get fieldErrors(): FieldError[] {
        return this.problem?.errors ?? [];
    }
}

/** 429: too many requests. Retried automatically until retries run out. */
export class VojoRateLimitError extends VojoAPIError {
    /** Seconds to wait before retrying, when the API said. */
    get retryAfter(): number | undefined {
        return parseRetryAfter(this.headers.get("retry-after"));
    }
}

/** No response arrived: DNS, refused or dropped connection. */
export class VojoConnectionError extends VojoError {}
/** The request took longer than `timeout`. */
export class VojoTimeoutError extends VojoConnectionError {}
/** The API's paging metadata could not be followed safely. */
export class VojoPaginationError extends VojoError {}

export type WebhookVerificationErrorKind =
    | "missing_header"
    | "malformed_header"
    | "no_matching_signature"
    | "timestamp_out_of_tolerance"
    | "invalid_payload";

/** A webhook delivery failed verification. Do not process it. */
export class VojoWebhookVerificationError extends VojoError {
    readonly kind: WebhookVerificationErrorKind;

    constructor(kind: WebhookVerificationErrorKind, message: string) {
        super(message);
        this.kind = kind;
    }
}

const classFor = (status: number): typeof VojoAPIError => {
    if (status === 401) return VojoAuthenticationError;
    if (status === 402 || status === 403) return VojoPermissionError;
    if (status === 404) return VojoNotFoundError;
    if (status === 409) return VojoConflictError;
    if (status === 429) return VojoRateLimitError;
    if (status === 400 || status === 413 || status === 422) return VojoValidationError;
    if (status >= 500) return VojoServerError;
    return VojoAPIError;
};

export const apiErrorFor = (status: number, problem: Problem | undefined, headers: Headers, hint?: string): VojoAPIError =>
    new (classFor(status))(status, problem, headers, hint);
