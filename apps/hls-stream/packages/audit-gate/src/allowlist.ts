import { AllowedAdvisory } from './types.js';

/**
 * Advisories this repository knowingly ships with. An entry says the exposure
 * was looked at and cannot be closed by a dependency bump today, never that it
 * is harmless, and the gate fails on any entry that stops matching the report.
 */
export const ALLOWED_ADVISORIES: readonly AllowedAdvisory[] = [
  {
    ghsa: 'GHSA-848j-6mx2-7j84',
    packageName: 'elliptic',
    reviewedSeverity: 'low',
    reviewedPatchedVersions: '>=6.6.2',
    reason:
      'No release fixes it anywhere. GitHub\'s advisory lists no fixed version, and the registry has no elliptic above 6.6.1, checked 2026-09-27. pnpm 11 reports the patched range as ">=6.6.2", which it derives from the vulnerable range "<=6.6.1", where pnpm 9 reported "<0.0.0" for the same advisory. It reaches the client bundle through vite-plugin-node-polyfills and crypto-browserify, so it goes when that chain does or when elliptic publishes a fix.',
  },
];
