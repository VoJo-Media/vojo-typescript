// The whole flow: a site, a screen on it, and a wrapped creative for that screen.
import Vojo from "vojo";

const vojo = new Vojo(process.env.VOJO_SECRET_KEY);

const open = { operational: true, ranges: [{ start: "07:00", end: "22:00" }] };
const site = await vojo.sites.create({
    name: "Leeds Trinity",
    address: { street: "1 Market Street", city: "Leeds", postal_code: "LS1 6DT", country: "GB", latitude: 53.7966, longitude: -1.5432 },
    operating_times_enabled: true,
    operating_times: {
        monday: open,
        tuesday: open,
        wednesday: open,
        thursday: open,
        friday: open,
        saturday: open,
        sunday: { operational: false, ranges: [] },
    },
});
console.log(`Site ${site.id}`);

const screen = await vojo.screens.create({ name: "Lobby North", site_id: site.id, size_inches: 55, orientation: "portrait" });
console.log(`Screen ${screen.id}: store this against your own screen record`);

let wrapper = await vojo.wrappers.create({
    content_source: "https://cdn.example.com/creatives/77.mp4",
    content_type: "video",
    screen_id: screen.id,
    external_id: "creative-77",
    source: "YOUR_CMS",
    duration: 15,
    delivery_mode: "archive",
});
// Today a wrap finishes in the request, but the API may answer 202 and keep working.
while (wrapper.status === "processing") {
    await new Promise((done) => setTimeout(done, 2000));
    wrapper = await vojo.wrappers.retrieve(wrapper.id);
}
console.log(`Wrapper ${wrapper.id} is ${wrapper.status}`);
