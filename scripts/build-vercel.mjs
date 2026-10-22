import { cp, mkdir } from "node:fs/promises";

await mkdir("public/assets", { recursive: true });
await cp("index.html", "public/index.html");
await cp("assets", "public/assets", { recursive: true });
