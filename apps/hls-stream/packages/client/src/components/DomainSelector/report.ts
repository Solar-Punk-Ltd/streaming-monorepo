/**
 * The node picker's copyable report: what a viewer pastes to whoever runs the site when something
 * does not load. It holds the Test's sentences, the status rows, the build and the browser, and the
 * one address of the gateway that was tested. Every other provider is named, never addressed, so a
 * report carries nothing from the viewer's own settings beyond what they chose to test.
 */
import type { StatusRow } from './providerStatus';
import { CHECK_LABELS, type CheckResult } from './providerTest';

export interface TestedGateway {
  readonly name: string;
  readonly address: string;
  readonly results: readonly CheckResult[];
}

interface ReportInput {
  readonly tested: TestedGateway | null;
  readonly status: readonly StatusRow[];
  readonly build: string;
  readonly browser: string;
  readonly atMs: number;
}

const OUTCOME_WORDS = { passed: 'passed', failed: 'failed', skipped: 'not tested' } as const;

export function reportText({ tested, status, build, browser, atMs }: ReportInput): string {
  const lines = [
    'Stream viewer report',
    `Made: ${new Date(atMs).toISOString()}`,
    `Build: ${build}`,
    `Browser: ${browser}`,
    '',
  ];
  if (tested === null) {
    lines.push('No gateway was tested.');
  } else {
    lines.push(`Test of ${tested.name} (${tested.address})`);
    for (const { check, outcome, sentence } of tested.results) {
      lines.push(`${CHECK_LABELS[check]}: ${OUTCOME_WORDS[outcome]}. ${sentence}`);
    }
  }
  lines.push('', 'Status, the last minute');
  for (const { label, route, answered } of status) {
    lines.push(`${label}: ${route} ${answered}`);
  }
  return `${lines.join('\n')}\n`;
}
