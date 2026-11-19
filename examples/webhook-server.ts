// A webhook receiver, using only Node's http module. It needs no API key, just
// the signing secret. Express users: put express.raw({ type: "application/json" })
// on the route and pass req.body.
import { createServer } from "node:http";
import { webhooks, VojoWebhookVerificationError } from "@vojo-media/vojo";

const secret = process.env.VOJO_WEBHOOK_SECRET ?? "";

export const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
        let event;
        try {
            event = webhooks.constructEvent(Buffer.concat(chunks), req.headers["x-vojo-signature"], secret);
        } catch (error) {
            if (!(error instanceof VojoWebhookVerificationError)) throw error;
            console.error(`Rejected: ${error.kind}`);
            res.writeHead(400).end();
            return;
        }

        // Acknowledge first, then work. Dedupe on event.id: retries reuse it.
        res.writeHead(204).end();

        switch (event.type) {
            case "verification.ping":
                console.log(`Play ${event.payload.playId} was reported`);
                break;
            case "verification.score":
                console.log(`Play ${event.payload.playId} scored`);
                break;
            default:
                // New event types can arrive before you upgrade.
                console.log(`Ignoring ${event.type}`);
        }
    });
});

if (process.env.VOJO_EXAMPLE_ONE_SHOT) {
    // Used by scripts/run-examples.mjs: send one signed delivery to this server.
    server.listen(0, "127.0.0.1", async () => {
        const { port } = server.address() as { port: number };
        const payload = JSON.stringify({ eventType: "verification.ping", eventId: "evt_1", attemptId: "att_1", playId: "play_1" });
        const header = webhooks.generateTestHeader({ payload, secret });
        const signed = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: payload, headers: { "x-vojo-signature": header } });
        const tampered = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: `${payload} `, headers: { "x-vojo-signature": header } });
        console.log(`signed: ${signed.status}, tampered: ${tampered.status}`);
        server.close();
    });
} else {
    server.listen(3000, () => console.log("Listening on :3000"));
}
