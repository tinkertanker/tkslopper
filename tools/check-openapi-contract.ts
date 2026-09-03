import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const document = await readFile(
  join(toolDirectory, "../openapi/tkslopper.openapi.yaml"),
  "utf8",
);
const cancelledResponse = '"499": { $ref: "#/components/responses/Cancelled" }';

for (const path of ["/v1/chat/completions", "/v1/responses"]) {
  const start = document.indexOf(`\n  ${path}:\n`);
  const end = document.indexOf("\n  /", start + 1);
  if (start < 0 || !document.slice(start, end).includes(cancelledResponse)) {
    throw new Error(
      `${path} must declare the shared 499 cancellation response`,
    );
  }
}

console.log("OpenAPI inference cancellation contract passed.");
