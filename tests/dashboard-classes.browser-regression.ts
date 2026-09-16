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
      timeout: 30_000,
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
  installFetchGate();
}

/**
 * Deterministic release gate: holds matching /dashboard/api requests inside the page
 * until the test releases them. Unlike a millisecond delay, a wrong implementation
 * cannot pass merely because the browser was slow.
 */
function installFetchGate(): void {
  evalJs(
    "(() => { if (window.__gateInstalled) return 'ok'; window.__gateInstalled = true; window.__gate = null; window.__held = []; const real = window.fetch.bind(window); window.fetch = (input, init) => { const url = String(input && input.url ? input.url : input); if (window.__gate && url.endsWith(window.__gate)) { return new Promise((resolve, reject) => { window.__held.push(() => real(input, init).then(resolve, reject)); }); } return real(input, init); }; return 'ok'; })()",
  );
}

function setGate(match: string | null): void {
  evalJs(
    `(() => { window.__gate = ${match === null ? "null" : JSON.stringify(match)}; window.__held = []; return 'ok'; })()`,
  );
}

function heldCount(): number {
  return evalJs<number>("window.__held.length");
}

function releaseHeld(): void {
  evalJs(
    "(() => { const next = window.__held.shift(); if (next) next(); return 'ok'; })()",
  );
}

/** Completed-handler count from the injected settlement probe. */
function handlerCompleted(): number {
  return evalJs<number>("window.__handlers.completed");
}

/**
 * Waits for the exact tracked handler promise to settle: the probe resolves it only after
 * the listener's own awaited work (including its refresh fetches and cleanup) has finished.
 */
async function waitForHandlerSettlement(
  completedBefore: number,
  timeoutMs = 8_000,
): Promise<void> {
  await waitFor<{ pending: number; completed: number }>(
    "({ pending: window.__handlers.pending, completed: window.__handlers.completed })",
    (state) => state.pending === 0 && state.completed >= completedBefore + 1,
    timeoutMs,
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

/** Defect 1: a held pause of A must not relabel B after the operator switches. */
async function regressionPauseDoesNotRelabelAnotherClass(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();

  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  check("1. class A opens before pausing", true, "P5 Maths — Term 3");

  const pauseCompletedBefore = handlerCompleted();
  setGate("/dashboard/api/classes/update");
  agentBrowser(["click", "#class-pause"]);
  await confirmDialog();
  await waitFor<number>("window.__held.length", (count) => count === 1);
  // Switch to B while A's classes/update is held open by the gate.
  selectClassRow(2);
  await waitFor<string>(heading, (value) => value === "P4 Science — Term 3");
  releaseHeld();
  await waitForHandlerSettlement(pauseCompletedBefore);
  // The list only shows A as paused once A's completion has fully settled.
  await waitFor<string>(
    "document.querySelector('#classes tbody tr:nth-child(1) td:nth-child(3)').textContent",
    (value) => value === "Paused",
  );
  setGate(null);

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

/** Finding 1a: a held group save must not discard a newer group's draft. */
async function regressionHeldGroupSaveKeepsNewerDraft(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();
  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  await waitFor<number>(
    "document.querySelectorAll('#class-groups tbody tr').length",
    (count) => count >= 4,
  );

  // Open Group 1 and hold its save open.
  agentBrowser([
    "click",
    "#class-groups tbody tr:nth-child(1) button:nth-of-type(3)",
  ]);
  await waitFor<string>(
    "document.getElementById('group-edit-heading').textContent",
    (value) => value === "Adjust group: Group 1",
  );
  evalJs(
    "(() => { document.querySelector('#group-edit-fields [name=budget_microcents]').value = '123000000'; return 'ok'; })()",
  );
  const firstSaveCompleted = handlerCompleted();
  setGate("/dashboard/api/groups/update");
  evalJs(
    "(() => { document.getElementById('group-edit-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<number>("window.__held.length", (count) => count === 1);

  // Open Group 2 and type a draft while Group 1's save is still held.
  agentBrowser([
    "click",
    "#class-groups tbody tr:nth-child(2) button:nth-of-type(3)",
  ]);
  await waitFor<string>(
    "document.getElementById('group-edit-heading').textContent",
    (value) => value === "Adjust group: Group 2",
  );
  evalJs(
    "(() => { document.querySelector('#group-edit-fields [name=budget_microcents]').value = '777000000'; return 'ok'; })()",
  );

  const statusBeforeRelease = evalJs<string>(
    "document.getElementById('group-edit-status').textContent",
  );
  releaseHeld();
  await waitForHandlerSettlement(firstSaveCompleted);
  // Group 1's save lands in the store, which re-renders the groups table.
  await waitFor<string>(
    "document.querySelector('#class-groups tbody tr:nth-child(1) td:nth-child(4)').textContent",
    (value) => value.includes("123,000,000"),
  );
  setGate(null);

  const panelHidden = evalJs<boolean>(
    "document.getElementById('group-edit-panel').hidden",
  );
  const editorHeading = evalJs<string>(
    "document.getElementById('group-edit-heading').textContent",
  );
  const draftBudget = evalJs<string>(
    "document.querySelector('#group-edit-fields [name=budget_microcents]').value",
  );
  const editorStatus = evalJs<string>(
    "document.getElementById('group-edit-status').textContent",
  );
  const groupOneBudget = evalJs<string>(
    "document.querySelector('#class-groups tbody tr:nth-child(1) td:nth-child(4)').textContent",
  );
  check(
    "4a. Group 2's editor stays open after Group 1's held save completes",
    panelHidden === false,
    `hidden=${panelHidden}`,
  );
  check(
    "4b. the editor still targets Group 2",
    editorHeading === "Adjust group: Group 2",
    editorHeading,
  );
  check(
    "4c. Group 2's draft is intact",
    draftBudget === "777000000",
    draftBudget,
  );
  check(
    "4d. Group 2's editor status is exactly unchanged by Group 1's completion",
    editorStatus === statusBeforeRelease,
    `before=${JSON.stringify(statusBeforeRelease)} after=${JSON.stringify(editorStatus)}`,
  );
  check(
    "4e. Group 1's save was still applied",
    groupOneBudget.includes("123,000,000"),
    groupOneBudget,
  );

  // A newer edit in the SAME open editor must also survive a held save.
  const setDraft = (value: string) =>
    evalJs(
      `(() => { const field = document.querySelector('#group-edit-fields [name=budget_microcents]'); field.value = '${value}'; field.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`,
    );
  setDraft("555000000");
  const sameEditorCompleted = handlerCompleted();
  setGate("/dashboard/api/groups/update");
  evalJs(
    "(() => { document.getElementById('group-edit-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<number>("window.__held.length", (count) => count === 1);
  setDraft("999000000");
  releaseHeld();
  await waitForHandlerSettlement(sameEditorCompleted);
  setGate(null);

  const sameFormHidden = evalJs<boolean>(
    "document.getElementById('group-edit-panel').hidden",
  );
  const sameFormDraft = evalJs<string>(
    "document.querySelector('#group-edit-fields [name=budget_microcents]').value",
  );
  const sameFormStatus = evalJs<string>(
    "document.getElementById('group-edit-status').textContent",
  );
  check(
    "4f. a newer edit in the same open editor keeps the editor open",
    sameFormHidden === false,
    `hidden=${sameFormHidden}`,
  );
  check(
    "4g. the newer same-editor draft is intact",
    sameFormDraft === "999000000",
    sameFormDraft,
  );
  check(
    "4h. the newer draft is reported as saved-but-superseded, not closed",
    sameFormStatus ===
      "Saved the earlier version; your newer edits are not saved yet.",
    sameFormStatus,
  );

  // An unheld save still closes the editor and reports success.
  setDraft("444000000");
  evalJs(
    "(() => { document.getElementById('group-edit-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<string>(
    "document.getElementById('group-edit-status').textContent",
    (value) => value === "Group updated.",
  );
  const normalHidden = evalJs<boolean>(
    "document.getElementById('group-edit-panel').hidden",
  );
  check(
    "4i. a normal group save closes the editor and reports success",
    normalHidden === true,
    `hidden=${normalHidden}`,
  );

  // Cross-class: a held save for class A must not write into class B's open editor.
  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  await waitFor<number>(
    "document.querySelectorAll('#class-groups tbody tr').length",
    (count) => count >= 4,
  );
  agentBrowser([
    "click",
    "#class-groups tbody tr:nth-child(1) button:nth-of-type(3)",
  ]);
  await waitFor<string>(
    "document.getElementById('group-edit-heading').textContent",
    (value) => value === "Adjust group: Group 1",
  );
  const crossClassCompleted = handlerCompleted();
  setGate("/dashboard/api/groups/update");
  evalJs(
    "(() => { document.getElementById('group-edit-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<number>("window.__held.length", (count) => count === 1);

  selectClassRow(2);
  await waitFor<string>(heading, (value) => value === "P4 Science — Term 3");
  await waitFor<number>(
    "document.querySelectorAll('#class-groups tbody tr').length",
    (count) => count >= 1,
  );
  agentBrowser([
    "click",
    "#class-groups tbody tr:nth-child(1) button:nth-of-type(3)",
  ]);
  await waitFor<string>(
    "document.getElementById('group-edit-heading').textContent",
    (value) => value === "Adjust group: Science Group 1",
  );
  const crossStatusBefore = evalJs<string>(
    "document.getElementById('group-edit-status').textContent",
  );
  releaseHeld();
  await waitForHandlerSettlement(crossClassCompleted);
  setGate(null);
  const crossStatusAfter = evalJs<string>(
    "document.getElementById('group-edit-status').textContent",
  );
  const crossPanelHidden = evalJs<boolean>(
    "document.getElementById('group-edit-panel').hidden",
  );
  const crossHeading = evalJs<string>(
    "document.getElementById('group-edit-heading').textContent",
  );
  check(
    "4j. class A's completion leaves class B's editor status exactly unchanged",
    crossStatusAfter === crossStatusBefore,
    `before=${JSON.stringify(crossStatusBefore)} after=${JSON.stringify(crossStatusAfter)}`,
  );
  check(
    "4k. class B's editor stays open and still targets its own group",
    crossPanelHidden === false &&
      crossHeading === "Adjust group: Science Group 1",
    `hidden=${crossPanelHidden} heading=${crossHeading}`,
  );
}

/** Finding 1b: a held bulk create must not clear a newer draft typed for another class. */
async function regressionHeldBulkCreateKeepsNewerDraft(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();
  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");

  evalJs(
    "(() => { document.getElementById('group-names').value = 'Gate Group A'; return 'ok'; })()",
  );
  const bulkCompletedBefore = handlerCompleted();
  setGate("/dashboard/api/groups");
  evalJs(
    "(() => { document.getElementById('group-create-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<number>("window.__held.length", (count) => count === 1);

  // Switch class and type a newer draft while class A's create is still held.
  selectClassRow(2);
  await waitFor<string>(heading, (value) => value === "P4 Science — Term 3");
  evalJs(
    "(() => { document.getElementById('group-names').value = 'Draft B'; return 'ok'; })()",
  );

  releaseHeld();
  await waitForHandlerSettlement(bulkCompletedBefore);
  setGate(null);

  const draft = evalJs<string>("document.getElementById('group-names').value");
  const status = evalJs<string>(
    "document.getElementById('group-status').textContent",
  );
  check(
    "5a. the newer draft survives the older completion",
    draft === "Draft B",
    draft,
  );
  check(
    "5b. class A's completion message is not shown for class B",
    !status.includes("Created"),
    status,
  );

  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  const names = await waitFor<string[]>(
    "(() => [...document.querySelectorAll('#class-groups tbody tr')].map((tr) => tr.children[0].textContent))()",
    (rows) => rows.includes("Gate Group A"),
  );
  check(
    "5c. class A's bulk create was still applied",
    names.includes("Gate Group A"),
    JSON.stringify(names),
  );

  // An unheld create still clears its own draft and reports success.
  evalJs(
    "(() => { document.getElementById('group-names').value = 'Normal Group'; return 'ok'; })()",
  );
  evalJs(
    "(() => { document.getElementById('group-create-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<string>(
    "document.getElementById('group-status').textContent",
    (value) => value.startsWith("Created"),
  );
  const cleared = evalJs<string>(
    "document.getElementById('group-names').value",
  );
  check(
    "5d. a normal bulk create clears its draft and reports success",
    cleared === "",
    JSON.stringify(cleared),
  );
}

/** Finding 2: credential actions are serialized so a secret cannot be overwritten unseen. */
async function regressionCredentialsAreSerialized(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();
  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  await waitFor<number>(
    "document.querySelectorAll('#class-keys tbody tr').length",
    (count) => count === 2,
  );
  // Answer confirmation prompts inline so a pre-fix dispatch cannot block the renderer
  // with a modal dialog and hide the result.
  evalJs("(() => { window.confirm = () => true; return 'ok'; })()");

  const rotateCompletedBefore = handlerCompleted();
  setGate("/dashboard/api/groups/rotate");
  agentBrowser([
    "click",
    "#class-keys tbody tr:nth-child(1) button:nth-of-type(1)",
  ]);
  await waitFor<number>("window.__held.length", (count) => count === 1);

  const controls = evalJs<{ rotate: boolean; issue: boolean }>(
    "(() => ({ rotate: [...document.querySelectorAll('#class-keys tbody button')].filter((b) => b.textContent === 'Rotate').every((b) => b.disabled), issue: [...document.querySelectorAll('#class-groups tbody button')].filter((b) => b.textContent === 'API key' || b.textContent === 'Join code').every((b) => b.disabled) }))()",
  );
  check(
    "6a. rotation and issuance controls are disabled while a credential action is pending",
    controls.rotate && controls.issue,
    JSON.stringify(controls),
  );

  // A second legitimate rotation of a different key must not dispatch while the first is
  // pending. click() dispatches synchronously, so a dispatch would already be held here.
  evalJs(
    "(() => { const b = document.querySelector('#class-keys tbody tr:nth-child(2) button:nth-of-type(1)'); if (b) b.click(); return 'ok'; })()",
  );
  check(
    "6b. the second rotation is not dispatched while the first is pending",
    heldCount() === 1,
    `held=${heldCount()}`,
  );

  releaseHeld();
  await waitForHandlerSettlement(rotateCompletedBefore);
  setGate(null);

  const secret = evalJs<string>(
    "document.getElementById('class-secret-value').textContent",
  );
  const secretStatus = evalJs<string>(
    "document.getElementById('class-secret-status').textContent",
  );
  // Positively wait for the pending guard to release rather than sampling once.
  const enabledAfter = await waitFor<boolean>(
    "(() => { const rotate = [...document.querySelectorAll('#class-keys tbody button')].filter((b) => b.textContent === 'Rotate'); return rotate.length > 0 && rotate.every((b) => !b.disabled); })()",
    (enabled) => enabled,
  );
  check(
    "6c. the first rotation's secret stays accessible and is the one shown",
    secret.length > 0 && secretStatus.includes("Group 1"),
    `${secretStatus} | ${secret.slice(0, 14)}…`,
  );
  check(
    "6d. controls are re-enabled once the credential action settles",
    enabledAfter,
    `enabled=${enabledAfter}`,
  );
}

/** Long group names must not let the sticky first column cover the actions. */
async function regressionStickyNameColumnIsBounded(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();
  agentBrowser(["set", "viewport", "1280", "900", "2"]);
  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  await waitFor<number>(
    "document.querySelectorAll('#class-groups tbody tr').length",
    (count) => count >= 4,
  );

  // Create a group through the real path so the row carries an API-legal 200-char name.
  const longName = "M".repeat(200);
  evalJs(
    `(() => { document.getElementById('group-names').value = ${JSON.stringify(longName)}; return 'ok'; })()`,
  );
  evalJs(
    "(() => { document.getElementById('group-create-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<boolean>(
    "(() => [...document.querySelectorAll('#class-groups tbody tr')].some((tr) => tr.children[0].textContent.length === 200))()",
    (found) => found,
  );

  const geometry = evalJs<{
    stickyW: number;
    overlay: boolean;
    rowH: number;
    title: number;
    text: number;
  }>(
    "(() => { const row = [...document.querySelectorAll('#class-groups tbody tr')].find((tr) => tr.children[0].textContent.length === 200); const td = row.children[0]; const wrap = document.querySelector('#class-groups').closest('.table-wrap'); wrap.scrollLeft = wrap.scrollWidth; const sticky = td.getBoundingClientRect(); const last = row.children[row.children.length - 1].getBoundingClientRect(); return { stickyW: Math.round(sticky.width), overlay: Math.round(sticky.right) > Math.round(last.left), rowH: Math.round(row.getBoundingClientRect().height), title: td.title.length, text: td.textContent.length }; })()",
  );
  check(
    "7a. sticky name column stays bounded with a 200-character name",
    geometry.stickyW <= 240,
    `width=${geometry.stickyW}`,
  );
  check(
    "7b. the sticky name does not overlay the actions column",
    geometry.overlay === false,
    `overlay=${geometry.overlay}`,
  );
  check(
    "7c. the full name remains accessible and uncut in the DOM",
    geometry.title === 200 && geometry.text === 200,
    `title=${geometry.title} text=${geometry.text}`,
  );
  check(
    "7d. the row stays a single readable line",
    geometry.rowH <= 120,
    `rowH=${geometry.rowH}`,
  );
}

/** Long names must stay usable and actions reachable on narrow viewports. */
async function regressionNarrowViewportKeepsActionsReachable(): Promise<void> {
  await post("/__scenario", { scenario: "populated" });
  await openDashboard();
  selectClassRow(1);
  await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
  await waitFor<number>(
    "document.querySelectorAll('#class-groups tbody tr').length",
    (count) => count >= 4,
  );

  const longName = "M".repeat(200);
  evalJs(
    `(() => { document.getElementById('group-names').value = ${JSON.stringify(longName)}; return 'ok'; })()`,
  );
  evalJs(
    "(() => { document.getElementById('group-create-form').requestSubmit(); return 'ok'; })()",
  );
  await waitFor<boolean>(
    "(() => [...document.querySelectorAll('#class-groups tbody tr')].some((tr) => tr.children[0].textContent.length === 200))()",
    (found) => found,
  );

  for (const width of [390, 320]) {
    agentBrowser(["set", "viewport", String(width), "800", "2"]);
    selectClassRow(1);
    await waitFor<string>(heading, (value) => value === "P5 Maths — Term 3");
    await waitFor<number>(
      "document.querySelectorAll('#class-groups tbody tr').length",
      (count) => count >= 5,
    );
    const rowIndex = evalJs<number>(
      "(() => [...document.querySelectorAll('#class-groups tbody tr')].findIndex((tr) => tr.children[0].textContent.length === 200) + 1)()",
    );
    // Scroll the row into view and measure in the same eval: scrollIntoView updates layout
    // synchronously, so elementFromPoint hit-tests the settled positions.
    const metrics = evalJs<{
      stickyW: number;
      reachable: number;
      buttons: number;
      covered: string[];
    }>(
      `(() => { const row = document.querySelector('#class-groups tbody tr:nth-child(${rowIndex})'); row.scrollIntoView({block:'center', inline:'nearest'}); const td = row.children[0]; const wrap = document.querySelector('#class-groups').closest('.table-wrap'); wrap.scrollLeft = wrap.scrollWidth; const sticky = td.getBoundingClientRect(); const actions = row.children[row.children.length - 1]; const buttons = [...actions.querySelectorAll('button')]; const covered = []; let reachable = 0; for (const b of buttons) { const r = b.getBoundingClientRect(); const top = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); if (top === b || b.contains(top)) reachable += 1; else covered.push(b.textContent); } return { stickyW: Math.round(sticky.width), reachable, buttons: buttons.length, covered }; })()`,
    );
    check(
      `8. sticky name column is narrow at ${width}px`,
      metrics.stickyW <= 130,
      `width=${metrics.stickyW}`,
    );
    check(
      `8. all four action buttons are hit-testable at ${width}px`,
      metrics.buttons === 4 && metrics.reachable === 4,
      `reachable=${metrics.reachable}/${metrics.buttons} covered=${JSON.stringify(metrics.covered)}`,
    );

    // A real hit-tested click proves the button is actually reachable.
    evalJs(
      "(() => { const wrap = document.querySelector('#class-groups').closest('.table-wrap'); wrap.scrollLeft = wrap.scrollWidth; return 'ok'; })()",
    );
    agentBrowser([
      "click",
      `#class-groups tbody tr:nth-child(${rowIndex}) button:nth-of-type(3)`,
    ]);
    let opened = false;
    try {
      await waitFor<string>(
        "document.getElementById('group-edit-heading').textContent",
        (value) => value.startsWith("Adjust group:"),
        4_000,
      );
      opened = true;
    } catch {
      opened = false;
    }
    check(
      `8. an action button on the long-name row is clickable at ${width}px`,
      opened,
      `opened=${opened}`,
    );
  }
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
      [
        "held group save keeps a newer draft",
        regressionHeldGroupSaveKeepsNewerDraft,
      ],
      [
        "held bulk create keeps a newer draft",
        regressionHeldBulkCreateKeepsNewerDraft,
      ],
      ["credential actions are serialized", regressionCredentialsAreSerialized],
      ["sticky name column is bounded", regressionStickyNameColumnIsBounded],
      [
        "narrow viewport keeps actions reachable",
        regressionNarrowViewportKeepsActionsReachable,
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
