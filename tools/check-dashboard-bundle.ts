/**
 * Checks the dashboard page served by the built control-plane bundle.
 *
 * The page embeds helper functions through Function.prototype.toString. The
 * production bundler keeps function names by inserting `__name(...)` calls,
 * which do not exist in the browser, so this check runs after `pnpm build`
 * against the real bundle rather than the test transform. It fails when the
 * served inline script contains that wrapper, does not compile, or its money
 * helpers give wrong answers.
 */
import { Script, createContext } from "node:vm";

type ControlPlaneModule = {
  handleControlPlane: (request: Request, env: unknown) => Promise<Response>;
};

const bundle = new URL(
  "../apps/control-plane/dist/control-plane/index.js",
  import.meta.url,
);

function fail(message: string): never {
  console.error(`Dashboard bundle check failed: ${message}`);
  process.exit(1);
}

const module = (await import(bundle.href)) as ControlPlaneModule;

// Synthetic, public values: only configuration shape is checked for this route.
const env = {
  DB: { prepare: () => undefined },
  TOKEN_SIGNING_SECRET: "public-fixture-signing-material-at-least-32-bytes",
  CREDENTIAL_PEPPER: "public-fixture-pepper-material-at-least-32-bytes",
  ADMIN_TOKEN: "public-fixture-admin-token-at-least-32-bytes",
  TOKEN_ISSUER: "https://control.example.invalid",
  DEPLOYMENT_ENV: "test",
  ENABLE_DEV_ISSUER: "false",
};
const response = await module.handleControlPlane(
  new Request("https://control.example.invalid/dashboard"),
  env,
);
if (response.status !== 200) fail(`GET /dashboard returned ${response.status}`);
const html = await response.text();
if (html.includes("__name(")) fail("the served page contains __name(");

const scripts = [
  ...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/gu),
]
  .map((match) => match[1] ?? "")
  .filter((script) => script.length > 0);
if (scripts.length === 0) fail("no inline script was found");
for (const script of scripts) {
  try {
    // Compiles without running; the page script needs a browser DOM.
    new Script(script);
  } catch (error) {
    fail(`an inline script does not compile: ${String(error)}`);
  }
}

// The helpers are embedded as one block immediately before `const money`.
const helpersStart = html.indexOf("const formatDollars = (");
const helpersEnd = html.indexOf("const money = ", helpersStart);
if (helpersStart < 0 || helpersEnd < 0) fail("embedded helpers were not found");
const result = new Script(
  `${html.slice(helpersStart, helpersEnd)}
   ({
     parsed: String(parseDollars("1,234.50").value),
     formatted: formatDollars(2000000000, true),
     cell: csvCell("=1"),
   });`,
).runInContext(createContext({})) as {
  parsed: string;
  formatted: string;
  cell: string;
};
if (result.parsed !== "123450000000")
  fail(`parseDollars returned ${result.parsed}`);
if (!result.formatted.includes("20.00"))
  fail(`formatDollars returned ${result.formatted}`);
if (!result.cell.startsWith("'"))
  fail(`csvCell did not neutralise a formula: ${result.cell}`);

console.log("Dashboard bundle check passed.");
