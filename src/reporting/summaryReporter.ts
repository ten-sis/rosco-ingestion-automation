/**
 * Writes a Markdown summary of each run to `.runs/summary-<timestamp>.md`: every scenario with the
 * design doc's case and expected outcome, what the scenario asserts, and its result, plus the doc
 * cases this suite has no scenario for.
 *
 * Reads the annotations `defineScenarioTests` attaches (`src/fixtures/test.ts`), and names a
 * failure by the `test.step` it happened in (the runner wraps every step and checkpoint in one).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { DESIGN_DOC_OPERATION_CASES, designDocCaseFor } from './designDocCases';

/** Doc cases with no scenario, and why. O1's wording is the caveat the whole run carries. */
const NO_SCENARIO: Readonly<Record<string, string>> = {
  O1: 'Not validated by this run. Every event in this run is simulated: GMS frames from a fixture TennaCAM and emulated Rosco webhook payloads, not a real tracker or camera. O1 needs real hardware (`OUT-OF-SCOPE.md`).',
  O20: 'Manual. A lost publish cannot be forced from outside the cluster, and the audit is what catches it (`OUT-OF-SCOPE.md`).',
  O26: 'Not covered. Needs control over the recorder\'s timing (`OUT-OF-SCOPE.md`).',
  O27: 'Not covered. Needs seeding the S3 raw folder (`OUT-OF-SCOPE.md`).',
  O28: 'Not covered. Needs an S3 outage (`OUT-OF-SCOPE.md`).',
};

/** Projects whose tests are not scenarios. Unit tests are counted, not listed. */
const SETUP_PROJECTS = new Set(['connectivity', 'preflight']);
const UNIT_PROJECT = 'unit';

interface Row {
  project: string;
  title: string;
  status: TestResult['status'];
  durationMs: number;
  annotations: Map<string, string>;
  failedAt?: string;
  error?: string;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** The first line of the error, plus its Expected/Received lines when it has them. */
function summarizeError(result: TestResult): string | undefined {
  const raw = result.errors[0]?.message ?? result.error?.message;
  if (!raw) return undefined;
  const lines = stripAnsi(raw).split('\n').map((l) => l.trim()).filter(Boolean);
  const detail = lines.filter((l) => /^(Expected|Received)/.test(l));
  return [lines[0], ...detail].filter(Boolean).join(' ');
}

/** The innermost `test.step` that failed, e.g. "final expect: asset assignee A". */
function failedStep(steps: readonly TestStep[]): string | undefined {
  for (const step of steps) {
    if (!step.error) continue;
    const inner = failedStep(step.steps);
    if (inner) return inner;
    if (step.category === 'test.step') return step.title;
  }
  return undefined;
}

function annotationsOf(test: TestCase, result: TestResult): Map<string, string> {
  const all = [...test.annotations, ...((result as { annotations?: TestCase['annotations'] }).annotations ?? [])];
  return new Map(all.map((a) => [a.type, a.description ?? '']));
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const STATUS_LABEL: Record<TestResult['status'], string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  timedOut: 'TIMED OUT',
  skipped: 'SKIPPED',
  interrupted: 'INTERRUPTED',
};

/** Markdown table cells cannot hold a raw pipe or newline. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Scenario ids sort as the doc does: O2 < O3.1 < O12a < O12b. */
function caseOrder(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export default class SummaryReporter implements Reporter {
  private readonly rows: Row[] = [];
  private startedAt = new Date();
  private unitCounts = { passed: 0, failed: 0 };

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '';
    // Only the final attempt counts; retries are off in this suite, but this stays correct if not.
    if (result.retry < test.retries && result.status !== 'passed' && result.status !== 'skipped') return;
    if (project === UNIT_PROJECT) {
      if (result.status === 'passed') this.unitCounts.passed += 1;
      else if (result.status !== 'skipped') this.unitCounts.failed += 1;
      return;
    }
    this.rows.push({
      project,
      title: test.title,
      status: result.status,
      durationMs: result.duration,
      annotations: annotationsOf(test, result),
      failedAt: failedStep(result.steps),
      error: summarizeError(result),
    });
  }

  onEnd(result: FullResult): void {
    const scenarios = this.rows.filter((r) => r.annotations.has('case'));
    const setup = this.rows.filter((r) => !r.annotations.has('case') && SETUP_PROJECTS.has(r.project));
    if (scenarios.length === 0 && setup.length === 0) return;

    scenarios.sort((a, b) => caseOrder(a.annotations.get('case') ?? '', b.annotations.get('case') ?? ''));
    const count = (s: TestResult['status']) => scenarios.filter((r) => r.status === s).length;

    const out: string[] = [];
    out.push(`# FR suite run, ${this.startedAt.toISOString()}`);
    out.push('');
    out.push(
      '**Simulated run.** Every event is emulated: GMS telemetry frames from a fixture TennaCAM, and Rosco ' +
        'identifications built by the suite. No real tracker, camera, or Rosco recognition is involved. ' +
        'The pipeline behind them (ingestion, consumers, scorecards) is the real one on this environment.',
    );
    out.push('');
    out.push(`- Environment: ${process.env.ENV ?? 'dv3'}`);
    out.push(`- Account: ${process.env.ACCOUNT_ID ?? '(unset)'}`);
    out.push(`- Emitter: ${process.env.EMITTER === 'becrud' ? 'becrud (`/v5/rosco-driver-events/publish`)' : 'webhook'}`);
    out.push(`- Overall: ${result.status}, ${duration(Date.now() - this.startedAt.getTime())}`);
    out.push(
      `- Scenarios: ${count('passed')} passed, ${count('failed') + count('timedOut')} failed, ${count('skipped')} skipped` +
        (this.unitCounts.passed + this.unitCounts.failed > 0
          ? `. Unit tests: ${this.unitCounts.passed} passed, ${this.unitCounts.failed} failed.`
          : '.'),
    );
    out.push('');

    if (setup.length > 0) {
      out.push('## Setup');
      out.push('');
      for (const r of setup) {
        out.push(`- ${STATUS_LABEL[r.status]} [${r.project}] ${r.title}${r.error ? `: ${r.error}` : ''}`);
      }
      out.push('');
    }

    if (scenarios.length > 0) {
      out.push('## Results');
      out.push('');
      out.push('| Case | Priority | Result | Time | Failed at |');
      out.push('|---|---|---|---|---|');
      for (const r of scenarios) {
        const failed = r.status === 'failed' || r.status === 'timedOut';
        out.push(
          `| ${r.annotations.get('case')} | ${r.annotations.get('priority') ?? ''} | ${STATUS_LABEL[r.status]} | ` +
            `${duration(r.durationMs)} | ${failed ? cell(r.failedAt ?? '(before the first step)') : ''} |`,
        );
      }
      out.push('');

      out.push('## Cases');
      out.push('');
      for (const r of scenarios) {
        const id = r.annotations.get('case') ?? '';
        out.push(`### ${id}: ${STATUS_LABEL[r.status]}`);
        out.push('');
        out.push(`- **Test:** ${r.title}`);
        const docCase = r.annotations.get('doc-case');
        if (docCase) out.push(`- **Design doc case:** ${docCase}`);
        const docExpected = r.annotations.get('doc-expected');
        if (docExpected) out.push(`- **Design doc expects:** ${docExpected}`);
        out.push(`- **This scenario asserts:** ${r.annotations.get('asserts') ?? ''}`);
        if (r.status === 'failed' || r.status === 'timedOut') {
          out.push(`- **Failed at:** ${r.failedAt ?? '(before the first step, during provisioning or setup)'}`);
          if (r.error) out.push(`- **Error:** \`${r.error.replace(/`/g, "'")}\``);
        }
        const asset = r.annotations.get('asset');
        if (asset) out.push(`- **Asset:** ${asset}, fleet ${r.annotations.get('fleet') ?? ''}`);
        out.push(`- **Time:** ${duration(r.durationMs)}`);
        out.push('');
      }
    }

    const ran = new Set(scenarios.map((r) => (r.annotations.get('case') ?? '').replace(/[a-z]$/, '')));
    const notRun = Object.keys(DESIGN_DOC_OPERATION_CASES).filter((id) => !ran.has(id) && !(id in NO_SCENARIO));
    out.push('## Design doc cases with no scenario');
    out.push('');
    out.push('| Case | Design doc case | Note |');
    out.push('|---|---|---|');
    for (const [id, note] of Object.entries(NO_SCENARIO)) {
      out.push(`| ${id} | ${cell(designDocCaseFor(id)?.case ?? '')} | ${cell(note)} |`);
    }
    out.push('');
    if (notRun.length > 0) {
      out.push(`Not selected in this run: ${notRun.sort(caseOrder).join(', ')}.`);
      out.push('');
    }

    const dir = path.join(process.cwd(), '.runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `summary-${this.startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, out.join('\n'));
    // eslint-disable-next-line no-console
    console.log(`\nRun summary: ${path.relative(process.cwd(), file)}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
