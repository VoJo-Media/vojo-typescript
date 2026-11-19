// Breaks the webhook verifier one way at a time and confirms the tests notice.
// A surviving mutation means the tests would miss that bug.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "src/webhooks.ts");
const source = readFileSync(file, "utf8");

const MUTATIONS = [
    ["never checks a signature", "if (!matched) {", "if (false) {"],
    ["accepts everything hex-shaped", "matched = timingSafeEqual(expected, Buffer.from(signature, \"utf8\")) || matched;", "matched = true;"],
    ["only tries the first v1", "for (const signature of signatures) {", "for (const signature of signatures.slice(0, 1)) {"],
    ["only tries the last v1", "for (const signature of signatures) {", "for (const signature of signatures.slice(-1)) {"],
    ["only tries the first secret", "for (const key of secrets) {", "for (const key of secrets.slice(0, 1)) {"],
    ["last compare wins", "|| matched;", ";"],
    ["no timestamp check", "if (Math.abs(now - Number(timestamp)) > tolerance) {", "if (false) {"],
    ["past timestamps only", "Math.abs(now - Number(timestamp)) > tolerance", "now - Number(timestamp) > tolerance"],
    ["future timestamps only", "Math.abs(now - Number(timestamp)) > tolerance", "Number(timestamp) - now > tolerance"],
    ["tolerance boundary off by one", "Math.abs(now - Number(timestamp)) > tolerance", "Math.abs(now - Number(timestamp)) >= tolerance"],
    ["ignores the caller's tolerance", "options.tolerance ?? DEFAULT_TOLERANCE_SECONDS", "DEFAULT_TOLERANCE_SECONDS"],
    ["timestamp not in signed content", "`${timestamp}.`", "`.`"],
    ["body not in signed content", ".update(body)", ".update(\"\")"],
    ["signs with the wrong hash", "\"sha256\"", "\"sha1\""],
    ["accepts duplicate t", "timestamps.length !== 1 ||", ""],
    ["accepts a non-digit t", "!/^\\d+$/.test(timestamp) ||", ""],
    ["accepts no v1 values", "|| signatures.length === 0", ""],
    ["skips the signature shape check", "if (!SIGNATURE_PATTERN.test(signature)) continue;", ""],
    ["reads v2 as a signature", "if (scheme === \"v1\")", "if (scheme === \"v1\" || scheme === \"v2\")"],
    ["allows tolerance zero", "|| tolerance <= 0 ", ""],
    ["allows an infinite tolerance", "!Number.isFinite(tolerance) || ", ""],
    ["allows a tolerance above the cap", " || tolerance > MAX_TOLERANCE_SECONDS", ""],
    ["no missing-header error", "if (!value) {", "if (false) {"],
    ["does not normalise event_type", "fields.eventType ?? fields.event_type", "fields.eventType"],
    ["does not normalise event_id", "fields.eventId ?? fields.event_id", "fields.eventId"],
    ["does not normalise attempt_id", "fields.attemptId ?? fields.attempt_id", "fields.attemptId"],
];

const runTests = () =>
    spawnSync(process.execPath, ["--import", "tsx", "--test", "test/webhooks.test.ts"], { cwd: root, stdio: "pipe", encoding: "utf8" }).status === 0;

let survived = 0;
try {
    if (!runTests()) throw new Error("Tests fail before any mutation.");
    for (const [name, from, to] of MUTATIONS) {
        if (!source.includes(from)) throw new Error(`Mutation "${name}" no longer applies: ${from}`);
        writeFileSync(file, source.replace(from, to));
        const killed = !runTests();
        console.log(`${killed ? "killed  " : "SURVIVED"}  ${name}`);
        if (!killed) survived++;
    }
} finally {
    writeFileSync(file, source);
}
console.log(`${MUTATIONS.length - survived}/${MUTATIONS.length} mutations killed`);
if (survived) process.exit(1);
