#!/usr/bin/env node

import { collectWindowsRuntimeDiagnostics } from '../lib/windows-runtime-diagnostics.mjs';

try {
  const report = await collectWindowsRuntimeDiagnostics();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.supported && report.status !== 'invalid' ? 0 : 2;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    version: 'windows-runtime-diagnostics/v1',
    platform: process.platform,
    supported: process.platform === 'win32',
    status: 'failed',
    error: { code: error?.code || 'WINDOWS_DIAGNOSTICS_FAILED', message: error?.message || String(error) },
  }, null, 2)}\n`);
  process.exitCode = 2;
}
