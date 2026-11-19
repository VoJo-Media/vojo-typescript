// Branch on the error class, or on `code` when you need more detail.
import Vojo, { VojoAPIError, VojoConflictError, VojoRateLimitError, VojoValidationError } from "vojo";

const vojo = new Vojo(process.env.VOJO_SECRET_KEY);

try {
    await vojo.screens.create({ name: "Lobby North", size_inches: 55 });
} catch (error) {
    if (error instanceof VojoValidationError) {
        for (const field of error.fieldErrors) console.error(field.pointer, field.detail);
    } else if (error instanceof VojoConflictError && error.code === "duplicate_name") {
        console.error("That name is taken.");
    } else if (error instanceof VojoRateLimitError) {
        console.error(`Slow down. Retry in ${error.retryAfter} seconds.`);
    } else if (error instanceof VojoAPIError) {
        console.error(`${error.status} ${error.code}. Quote ${error.requestId} to Vojo support.`);
    } else {
        throw error;
    }
}
console.log("Done");
