// Fixed one-shot entry. No config module, server, networking, Provider or secrets.
import { initializeFreshInstanceIdentity } from '../lib/instance-identity.mjs';
if (process.platform !== 'win32' || process.argv.length !== 2 ||
    process.env.AGENTOC_WINDOWS_SERVICE_ROLE !== 'control' ||
    process.env.AGENTOC_CONFIG_DIR !== 'C:\\ProgramData\\AgentoC\\instances\\owner\\config' ||
    process.env.AGENTOC_INSTANCE_ROOT !== 'C:\\ProgramData\\AgentoC\\instances\\owner') {
  console.error('IID_FIXED_SERVICE_CONTEXT_REQUIRED'); process.exitCode = 1;
} else {
  try {
    await initializeFreshInstanceIdentity({filePath:'C:\\ProgramData\\AgentoC\\instances\\owner\\config\\instance-identity.json'});
  } catch { console.error('IID_INITIALIZATION_REFUSED'); process.exitCode = 1; }
}
