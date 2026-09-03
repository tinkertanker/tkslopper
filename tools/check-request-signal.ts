import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("request-signal probe could not allocate a port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitFor(
  description: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // The local runtime may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const gatewayConfig = await readFile(
  join(toolDirectory, "../apps/gateway/wrangler.jsonc"),
  "utf8",
);
if (!gatewayConfig.includes('"enable_request_signal"')) {
  throw new Error(
    "gateway must enable the incoming request signal runtime flag",
  );
}

const directory = await mkdtemp(join(tmpdir(), "tkslopper-request-signal-"));
const port = await freePort();
const require = createRequire(import.meta.url);
const workerd = join(
  dirname(require.resolve("wrangler/package.json")),
  "../workerd/bin/workerd",
);
let output = "";
let child: ReturnType<typeof spawn> | undefined;

try {
  await writeFile(
    join(directory, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const worker :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2025-08-30",
  compatibilityFlags = ["enable_request_signal"],
);
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
`,
  );
  await writeFile(
    join(directory, "worker.js"),
    `const marker = "TKSLOPPER_REQUEST_SIGNAL_ABORTED";
export default {
  fetch(request) {
    request.signal.addEventListener("abort", () => console.log(marker), { once: true });
    const { readable, writable } = new IdentityTransformStream();
    sendPing(writable);
    return new Response(readable, { headers: { "content-type": "text/plain" } });
  },
};

async function sendPing(writable) {
  const writer = writable.getWriter();
  const ping = new TextEncoder().encode("ping\\r\\n");
  try {
    for (;;) {
      await writer.write(ping);
      await scheduler.wait(100);
    }
  } catch {
    // The client disconnected and the response stream is no longer writable.
  }
}
`,
  );
  child = spawn(workerd, ["serve", join(directory, "config.capnp")], {
    cwd: directory,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    "workerd readiness",
    () =>
      new Promise<boolean>((resolve) => {
        const socket = createConnection(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
  );

  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(baseUrl, { agent: false }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
      response.once("error", () => undefined);
    });
    request.once("error", reject);
    request.end();
  });
  await waitFor(
    "incoming request cancellation",
    () => output.includes("TKSLOPPER_REQUEST_SIGNAL_ABORTED"),
    5_000,
  );
  console.log("workerd incoming request cancellation conformance passed.");
} catch (error) {
  const tail = output.slice(-2000);
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n${tail}`,
  );
} finally {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child?.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  await rm(directory, { recursive: true, force: true });
}
