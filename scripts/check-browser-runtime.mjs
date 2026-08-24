import process from 'node:process';
import { collectBrowserRuntimeGraphViolations, BROWSER_RUNTIME_ROOT } from './browser-runtime-graph.mjs';

const violations = await collectBrowserRuntimeGraphViolations();

if (violations.length) {
  console.error(`DR-001 browser runtime dependency violations under ${BROWSER_RUNTIME_ROOT}:`);
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier ?? violation.reason}`);
  }
  process.exitCode = 1;
} else {
  console.log('DR-001 browser runtime dependency check passed: no node:* imports found.');
}
