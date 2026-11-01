// Fixed QA launch guards, with no process creation or elevation side effects.
export const powershellUtf8 = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;";

export function canaryLaunchGuard(startBeforeMs) {
  if (!Number.isSafeInteger(startBeforeMs) || startBeforeMs <= 0) throw new Error('Invalid launch deadline');
  const deadline = new Date(startBeforeMs).toISOString();
  return powershellUtf8 + `if([DateTime]::UtcNow -gt [DateTime]::Parse('${deadline}',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)){throw 'CANARY_LAUNCH_EXPIRED'};`;
}
