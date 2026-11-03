import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MODEL_CONTEXT_DIR } from './prompt-paths.mjs';

// The learning profile is user content, even though the surrounding memory
// directory also contains protected control files. Never grant a directory-wide
// exception, and reject links so the approved name cannot redirect a write.
export function isManagedLearningProfileWrite(approval, directory = MODEL_CONTEXT_DIR) {
  const params = approval?.params;
  if (!approval?.approvalId || approval?.providerMethod !== 'can_use_tool'
      || !['Write', 'Edit', 'MultiEdit'].includes(params?.tool_name)) return false;
  const target = params?.input?.file_path;
  if (typeof target !== 'string' || !isAbsolute(target)) return false;
  const expected = join(resolve(directory), 'user-learning-profile.md');
  if (target !== expected || resolve(target) !== expected) return false;
  try {
    if (realpathSync(dirname(expected)) !== dirname(expected)) return false;
    try {
      const stat = lstatSync(expected);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  } catch {
    return false;
  }
}
