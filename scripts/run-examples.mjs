// Runs each example against a Prism mock of the contract. Prism replays one
// fixed response, so auto-paging would rightly raise the repeated-cursor error:
// examples/list-screens.ts shows one page, and test/pagination.test.ts covers
// paging against a stub server.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shared = existsSync(join(root, "shared")) ? join(root, "shared") : resolve(root, "../shared");
const PORT = process.env.PRISM_PORT ?? "4021";
const baseUrl = `http://127.0.0.1:${PORT}`;

const prism = spawn(join(root, "node_modules/.bin/prism"), ["mock", join(shared, "api/vojo-api.public.json"), "--host", "127.0.0.1", "--port", PORT], {
    stdio: "ignore",
});

const waitForPrism = async () => {
    for (let i = 0; i < 100; i++) {
        try {
            await fetch(`${baseUrl}/v1/organisation`, { headers: { Authorization: "Bearer x" } });
            return;
        } catch {
            await new Promise((done) => setTimeout(done, 200));
        }
    }
    throw new Error("Prism did not start");
};

let failed = 0;
try {
    await waitForPrism();
    const env = {
        ...process.env,
        VOJO_BASE_URL: baseUrl,
        VOJO_SECRET_KEY: "vojo_live_mock",
        VOJO_WEBHOOK_SECRET: "vwsec_mock",
        VOJO_EXAMPLE_ONE_SHOT: "1",
    };
    for (const name of readdirSync(join(root, "examples")).filter((file) => file.endsWith(".ts"))) {
        const run = spawnSync(process.execPath, ["--import", "tsx", join("examples", name)], { cwd: root, env, encoding: "utf8" });
        console.log(`--- ${name}: exit ${run.status}\n${run.stdout}${run.stderr}`);
        if (run.status !== 0) failed++;
    }
    const paging = spawnSync(process.execPath, ["--import", "tsx", "scripts/prism-paging-check.ts"], { cwd: root, env, encoding: "utf8" });
    console.log(`--- auto-paging against the mock: exit ${paging.status}\n${paging.stdout}${paging.stderr}`);
    if (paging.status !== 0) failed++;
} finally {
    prism.kill();
}
if (failed) process.exit(1);
