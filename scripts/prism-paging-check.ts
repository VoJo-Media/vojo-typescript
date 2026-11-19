// Prism replays a fixed next_cursor, so walking its pages must raise the loop
// error rather than spin forever.
import Vojo, { VojoPaginationError } from "vojo";

const vojo = new Vojo();
try {
    for await (const screen of vojo.screens.list()) void screen;
    throw new Error("Expected the repeated-cursor error");
} catch (error) {
    if (!(error instanceof VojoPaginationError)) throw error;
    console.log(`Raised as expected: ${error.message}`);
}
