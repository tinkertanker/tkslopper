/**
 * Executable browser regressions for the course-centred dashboard.
 *
 * These drive the actual rendered dashboard script in Chromium through the harness in
 * `dashboard-classes.browser.ts` (mocked APIs). They are behavioural, not string
 * matching: each one exercises the defect's exact sequence in the browser.
 *
 * Covered oracle defects:
 *   1. Pause class A, then open class B while A's update is still in flight. B's
 *      heading, editor, actions, and status must stay B's.
 *   2. An ended class duplicated into a new future window must succeed, leave the
 *      source window untouched, and copy groups so they inherit the new window.
 *   3. After the option source is refreshed with a new product, choosing that product
 *      must resolve its environments instead of "No environments".
 *
 * Run: pnpm exec tsx tests/dashboard-classes.browser-regression.ts [port]
 * Exits non-zero when any regression fails.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[2] ?? 8791);
const base = `http://127.0.0.1:${port}`;
const session = "classes-regress";
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}\n`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function agentBrowser(args: string[], allowFailure = false): string {
  const result = spawnSync(
    "agent-browser",
    ["--session", session, "--restore", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, AGENT_BROWSER_NAMESPACE: "classes-regression" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

function evalJs<T>(expression: string): T {
  const output = agentBrowser(["eval", expression]);
  // agent-browser pretty-prints arrays and objects over several lines, so parse the
  // whole payload rather than a single line.
  const payload = output
    .split("\n")
    .filter((line) => !line.startsWith("[agent-browser]"))
    .join("\n")
    .trim();
  try {
    return JSON.parse(payload) as T;
  } catch {
    throw new Error(`could not parse eval output: ${output}`);
  }
}

async function waitFor<T>(
  expression: string,
  ready: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = evalJs<T>(expression);
      if (ready(last)) return last;
    } catch {
      // Page still settling.
    }
    await sleep(120);
  }
  throw new Error(
    `timed out waiting for ${expression}; last=${JSON.stringify(last)}`,
  );
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status}`);
}

async function openDashboard(): Promise<void> {
  agentBrowser(["dialog", "dismiss"], true);
  agentBrowser(["open", `${base}/`]);
  agentBrowser(["set", "viewport", "1440", "1000", "2"]);
  await waitFor<number>(
    "document.querySelectorAll('#classes tbody tr').length",
    (count) => count > 0,
  );
}

function selectClassRow(row: number): void {
  evalJs(
    `(() => { document.querySelector('#classes tbody tr:nth-child(${row})').scrollIntoView({block:'center'}); return 'ok'; })()`,
  );
  agentBrowser(["click", `#classes tbody tr:nth-child(${row}) button`]);
}

async function confirmDialog(): Promise<void> {
  await sleep(150);
  agentBrowser(["dialog", "accept"], true);
}

const heading = "document.getElementById('class-detail-heading').textContent";
const meta = "document.getElementById('class-detail-meta').textContent";
const actionStatus =
  "document.getElementById('class-action-status').textContent";
const pauseLabel = "document.getElementById('class-pause').textContent";
const editName =
  "document.querySelector('#class-edit-fields [name=name]').value";

/** Defect 1: a delayed pause of A must not relabel B after the operator switches. */
async function regressionPauseDoesNotRelabelAnotherClass(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await post("/__delay", { ms: 900 });
  await openDashboard();

  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  check("1. class A opens before pausing", true, "P5 Maths — Term 3");

  agentBrowser(["click", "#class-pause"]);
  await confirmDialog();
  // Switch to B while A's classes/update is still delayed on the server.
  selectClassRow(2);
  await waitFor<string>(heading, (value) => value === "P4 Science — Term 3");
  await sleep(1_600);

  const finalHeading = evalJs<string>(heading);
  const finalMeta = evalJs<string>(meta);
  const finalPause = evalJs<string>(pauseLabel);
  const finalEditName = evalJs<string>(editName);
  const finalStatus = evalJs<string>(actionStatus);

  check(
    "1a. heading stays B after A's pause completes",
    finalHeading === "P4 Science — Term 3",
    finalHeading,
  );
  check(
    "1b. meta stays B (tenant_school, Science course)",
    finalMeta.includes("Primary 4 Science") &&
      finalMeta.includes("tenant_school"),
    finalMeta.slice(0, 80),
  );
  check(
    "1c. actions stay B (active class offers Pause)",
    finalPause === "Pause class",
    finalPause,
  );
  check(
    "1d. editor stays B",
    finalEditName === "P4 Science — Term 3",
    finalEditName,
  );
  check(
    "1e. A's completion message is not shown on B",
    !finalStatus.includes("Class paused"),
    finalStatus,
  );

  await post("/__delay", { ms: 0 });
  agentBrowser(["click", "#refresh"]);
  await waitFor<number>(
    "document.querySelectorAll('#classes tbody tr').length",
    (count) => count > 0,
  );
  const rowOneStatus = evalJs<string>(
    "document.querySelector('#classes tbody tr:nth-child(1) td:nth-child(3)').textContent",
  );
  check(
    "1f. A was still paused server-side (mutation not lost)",
    rowOneStatus === "Paused",
    rowOneStatus,
  );
}

/** Defect 2: duplicating an ended class needs its own future window. */
async function regressionExpiredDuplicateUsesNewWindow(): Promise<void> {
  await post("/__scenario", { scenario: "expired" });
  await openDashboard();

  // Independent baseline: the source row's schedule before duplication, read from the
  // rendered list rather than from any date the harness computed.
  const sourceBefore = evalJs<string[]>(
    "(() => { const tr = [...document.querySelectorAll('#classes tbody tr')].find((row) => row.children[0].textContent.startsWith('P3 Art — Term 1')); return tr ? [tr.children[4].textContent, tr.children[5].textContent] : []; })()",
  );
  check(
    "2. source window captured before duplication",
    sourceBefore.length === 2,
    JSON.stringify(sourceBefore),
  );

  selectClassRow(1);
  await waitFor<string>(heading, (value) => value.includes("P3 Art"));

  agentBrowser(["click", "#class-duplicate"]);
  await waitFor<boolean>(
    "!document.getElementById('class-duplicate-panel').hidden",
    (visible) => visible,
  );
  // Timezone-agnostic: the prefilled window is compared as browser-local dates.
  const prefill = evalJs<{ starts: string; expires: string; future: boolean }>(
    "(() => { const f = document.getElementById('class-duplicate-fields'); const s = f.querySelector('[name=starts_at]').value; const e = f.querySelector('[name=expires_at]').value; return { starts: s, expires: e, future: Boolean(s) && Boolean(e) && new Date(e) > new Date() && new Date(e) > new Date(s) }; })()",
  );
  check(
    "2a. duplicate form prefills a future window, not the ended source window",
    prefill.future,
    `${prefill.starts} -> ${prefill.expires}`,
  );

  // Enter the new window using browser-local input values, and keep those same values
  // for the expected UTC display so no Node or browser timezone is assumed.
  const entered = evalJs<{ starts: string; ends: string }>(
    "(() => { const f = document.getElementById('class-duplicate-fields'); const pad = (n) => String(n).padStart(2, '0'); const local = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); const s = local(new Date(Date.now() + 86_400_000)); const e = local(new Date(Date.now() + 86_400_000 * 31)); f.querySelector('[name=name]').value = 'P3 Art — Term 2'; f.querySelector('[name=starts_at]').value = s; f.querySelector('[name=expires_at]').value = e; return { starts: s, ends: e }; })()",
  );
  agentBrowser(["click", "#class-duplicate-submit"]);
  await waitFor<string>(heading, (value) => value === "P3 Art — Term 2");

  // The expected display is derived in the browser from the same local input values.
  const expected = evalJs<string[]>(
    `(() => { const utc = (v) => new Date(v).toISOString().replace('T', ' ').replace('.000Z', ' UTC'); return [utc(${JSON.stringify(entered.starts)}), utc(${JSON.stringify(entered.ends)})]; })()`,
  );
  const newRow = evalJs<string[]>(
    "(() => { const tr = [...document.querySelectorAll('#classes tbody tr')].find((row) => row.children[0].textContent === 'P3 Art — Term 2'); return tr ? [tr.children[4].textContent, tr.children[5].textContent] : []; })()",
  );
  check(
    "2b. duplicate lands in the entered future window",
    newRow.length === 2 &&
      newRow[0] === expected[0] &&
      newRow[1] === expected[1],
    `entered ${entered.starts} -> ${entered.ends}; row ${JSON.stringify(newRow)} vs expected ${JSON.stringify(expected)}`,
  );

  const groupSchedules = await waitFor<string[][]>(
    "(() => [...document.querySelectorAll('#class-groups tbody tr')].map((tr) => [tr.children[0].textContent, tr.children[8].textContent, tr.children[9].textContent]))()",
    (rows) => rows.length >= 2,
  );
  check(
    "2c. copied groups inherit the new class window",
    groupSchedules.every(
      (row) => row[1] === "Inherits class" && row[2] === "Inherits class",
    ),
    JSON.stringify(groupSchedules),
  );

  const sourceAfter = evalJs<string[]>(
    "(() => { const tr = [...document.querySelectorAll('#classes tbody tr')].find((row) => row.children[0].textContent.startsWith('P3 Art — Term 1')); return tr ? [tr.children[4].textContent, tr.children[5].textContent] : []; })()",
  );
  check(
    "2d. source class keeps its original window",
    sourceAfter.length === 2 &&
      sourceAfter[0] === sourceBefore[0] &&
      sourceAfter[1] === sourceBefore[1],
    `${JSON.stringify(sourceBefore)} -> ${JSON.stringify(sourceAfter)}`,
  );
}

/** Defect 3: a refreshed option source must resolve a newly added product. */
async function regressionRefreshedOptionsResolveNewProduct(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();

  const before = evalJs<string[]>(
    "(() => [...document.querySelectorAll('#class-create-fields [data-role=select-product] option')].map((o) => o.textContent))()",
  );
  check(
    "3a. one product before refresh",
    before.length === 1,
    JSON.stringify(before),
  );

  await post("/__scenario", { scenario: "twoproducts" });
  agentBrowser(["click", "#refresh"]);
  const after = await waitFor<string[]>(
    "(() => [...document.querySelectorAll('#class-create-fields [data-role=select-product] option')].map((o) => o.textContent))()",
    (options) => options.includes("Arts academy"),
  );
  check(
    "3b. refreshed options expose the new product",
    after.includes("Arts academy"),
    JSON.stringify(after),
  );

  const environments = evalJs<string[]>(
    "(() => { const s = document.querySelector('#class-create-fields [data-role=select-product]'); const option = [...s.options].find((o) => o.textContent === 'Arts academy'); s.value = option.value; s.dispatchEvent(new Event('change')); return [...document.querySelectorAll('#class-create-fields [data-role=select-environment] option')].map((o) => o.textContent); })()",
  );
  check(
    "3c. selecting the new product lists its environment",
    environments.includes("studio") &&
      !environments.includes("No environments"),
    JSON.stringify(environments),
  );
}

async function startHarness(): Promise<ChildProcess> {
  if (!existsSync(tsxBin)) throw new Error(`tsx not found at ${tsxBin}`);
  const child = spawn(
    tsxBin,
    ["tests/dashboard-classes.browser.ts", String(port)],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/__health`);
      if (response.ok) return child;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  child.kill("SIGKILL");
  throw new Error("harness did not become ready");
}

async function main(): Promise<void> {
  const harness = await startHarness();
  try {
    // Each regression runs independently so a pre-fix failure does not hide the rest.
    const regressions: Array<[string, () => Promise<void>]> = [
      [
        "pause does not relabel another class",
        regressionPauseDoesNotRelabelAnotherClass,
      ],
      [
        "expired duplicate uses a new window",
        regressionExpiredDuplicateUsesNewWindow,
      ],
      [
        "refreshed options resolve a new product",
        regressionRefreshedOptionsResolveNewProduct,
      ],
    ];
    for (const [label, run] of regressions) {
      try {
        await run();
      } catch (error) {
        check(
          `regression ran to completion: ${label}`,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    agentBrowser(["close"], true);
    harness.kill("SIGTERM");
    setTimeout(() => harness.kill("SIGKILL"), 2_000).unref();
  }
  const failures = checks.filter((entry) => !entry.ok);
  process.stdout.write(
    `\n${checks.length - failures.length}/${checks.length} checks passed\n`,
  );
  process.exit(failures.length > 0 ? 1 : 0);
}

void main();
