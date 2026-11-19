// Check your key works, and see which organisation it belongs to.
import Vojo from "vojo";

const vojo = new Vojo(process.env.VOJO_SECRET_KEY);

const organisation = await vojo.organisation.retrieve();
console.log(`Connected to ${organisation.name}`);
