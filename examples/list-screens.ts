// One page, then manual paging. `for await` walks every page for you.
import Vojo from "@vojo-media/vojo";

const vojo = new Vojo(process.env.VOJO_SECRET_KEY);

const page = await vojo.screens.list({ limit: 10 });
for (const screen of page.data) console.log(screen.id, screen.name);
console.log(`More pages: ${page.meta.has_more}`);

// To walk every screen:
//   for await (const screen of vojo.screens.list()) console.log(screen.name);
