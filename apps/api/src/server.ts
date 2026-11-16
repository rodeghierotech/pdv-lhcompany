import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3333);
const app = createApp();

// Product/inventory routes are local-only until online authentication exists.
await app.listen({ host: "127.0.0.1", port });
