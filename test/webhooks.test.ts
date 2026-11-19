import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { constructEvent, generateTestHeader, verifySignature, Vojo, VojoError, VojoWebhookVerificationError, webhooks } from "../src/index";
import { readShared } from "./helpers";

type Vector = {
    name: string;
    body: string;
    header: string | null;
    secrets: string[];
    now: number;
    tolerance_seconds: number;
    expect: { ok: true; event: { type: string; id: string; attempt_id: string } } | { ok: false; error: string };
};

const { vectors } = readShared("webhook-vectors.json") as { vectors: Vector[] };

describe("shared webhook vectors", () => {
    for (const vector of vectors) {
        const run = (body: string | Uint8Array) =>
            constructEvent(body, vector.header, vector.secrets, { now: vector.now, tolerance: vector.tolerance_seconds });
        const expected = vector.expect;

        for (const [label, body] of [["string", vector.body], ["bytes", Buffer.from(vector.body, "utf8")]] as const) {
            it(`${vector.name} (${label})`, () => {
                if (expected.ok) {
                    const event = run(body);
                    assert.equal(event.type, expected.event.type);
                    assert.equal(event.id, expected.event.id);
                    assert.equal(event.attempt_id, expected.event.attempt_id);
                    assert.deepEqual(event.payload, JSON.parse(vector.body));
                } else {
                    assert.throws(
                        () => run(body),
                        (error: unknown) => error instanceof VojoWebhookVerificationError && error.kind === expected.error
                    );
                }
            });
        }
    }

    it("covers the cases every SDK depends on", () => {
        const names = vectors.map((vector) => vector.name);
        for (const name of ["valid_single_signature", "tampered_body", "expired", "roll_overlap_only_second_matches"]) assert.ok(names.includes(name), name);
    });
});

describe("webhooks", () => {
    const secret = "vwsec_abc";
    const body = JSON.stringify({ eventType: "verification.score", eventId: "evt_1", attemptId: "att_1" });

    it("is available standalone, statically and needs no key", () => {
        assert.equal(Vojo.webhooks, webhooks);
        assert.equal(webhooks.constructEvent, constructEvent);
    });

    it("explains the mistake when given a parsed body", () => {
        assert.throws(() => verifySignature({ eventType: "x" } as unknown as string, "t=1,v1=a", secret), /raw request body/);
    });

    it("refuses to turn the timestamp check off", () => {
        for (const tolerance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 86_401]) {
            assert.throws(() => verifySignature(body, generateTestHeader({ payload: body, secret }), secret, { tolerance }), VojoError);
        }
    });

    it("requires a secret", () => {
        assert.throws(() => verifySignature(body, "t=1,v1=a", []), /secret is required/);
        assert.throws(() => verifySignature(body, "t=1,v1=a", ""), /secret is required/);
    });

    it("tells the receiver why a header is missing", () => {
        assert.throws(() => verifySignature(body, undefined, secret), /secret is rolled/);
    });

    it("generateTestHeader produces what the verifier accepts, including two secrets", () => {
        const event = constructEvent(body, generateTestHeader({ payload: body, secret }), secret);
        assert.equal(event.type, "verification.score");
        const both = generateTestHeader({ payload: body, secret: ["vwsec_new", "vwsec_old"] });
        assert.equal(constructEvent(body, both, "vwsec_old").id, "evt_1");
    });

    it("uses the current time by default", () => {
        const old = generateTestHeader({ payload: body, secret, timestamp: Math.floor(Date.now() / 1000) - 301 });
        assert.throws(() => verifySignature(body, old, secret), /seconds from now/);
    });

    it("rejects verified bodies that are not event objects", () => {
        for (const payload of ["[1]", "null", "{}"]) {
            assert.throws(
                () => constructEvent(payload, generateTestHeader({ payload, secret }), secret),
                (error: unknown) => error instanceof VojoWebhookVerificationError && error.kind === "invalid_payload"
            );
        }
    });

    it("accepts a header that arrives as an array", () => {
        const [t, v1] = generateTestHeader({ payload: body, secret }).split(",") as [string, string];
        assert.equal(constructEvent(body, [t, v1], secret).id, "evt_1");
    });
});
