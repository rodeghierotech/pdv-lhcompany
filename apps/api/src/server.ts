import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3333);
const app = createApp();

await app.listen({ host: "0.0.0.0", port });
