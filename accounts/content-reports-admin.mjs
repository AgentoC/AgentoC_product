// Local operator access only; no public list/content/status-update endpoint.
import { createContentReportStore, validateContentReportId } from './content-reports.mjs';
const [action, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const filePath = option('--file');
if (!['list', 'show', 'status'].includes(action) || !filePath) {
  console.error('Usage: node accounts/content-reports-admin.mjs list|show|status --file <protected-db> [--request-id <uuid>] [--status in_review|closed] [--include-content] [--erase-content]');
  process.exitCode = 2;
} else {
  let store;
  try {
    store = await createContentReportStore({ filePath, create: false, readOnly: action !== 'status' });
    const requestId = action === 'list' ? '' : validateContentReportId(option('--request-id'));
    const value = action === 'list' ? store.list() : action === 'show'
      ? { ...store.get(requestId), ...(args.includes('--include-content') ? { content: store.readContent(requestId) } : {}) }
      : store.setStatus(requestId, option('--status'), { eraseContent: args.includes('--erase-content') });
    console.log(JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(error.code?.startsWith('content_report_') ? error.code : 'content_report_operator_failed');
    process.exitCode = 1;
  } finally { store?.close(); }
}
