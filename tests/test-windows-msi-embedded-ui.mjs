import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(repositoryRoot, 'packaging', 'windows', 'agentoc-installer-embedded-ui.cpp'),
  'utf8',
);
const initializeStart = source.indexOf('extern "C" __declspec(dllexport) UINT __stdcall InitializeEmbeddedUI');
assert.notEqual(initializeStart, -1, 'embedded UI initialization entrypoint exists');
const initialize = source.slice(initializeStart);
assert.match(initialize, /g\.installPath\.clear\(\)/, 'no install folder is prefilled before the user chooses one');
assert.match(source, /CoCreateInstance\(CLSID_FileOpenDialog[\s\S]*?FOS_PICKFOLDERS/, 'Browse uses the modern Windows shell folder picker');
assert.match(source, /SetWindowTextW\(g\.pathEdit, path\)/, 'the selected folder is copied into the custom path field');

assert.match(
  initialize,
  /HANDLE initializationEvents\[\]\s*=\s*\{\s*gUiReadyEvent\s*,\s*gExitEvent\s*\};\s*DWORD wait\s*=\s*WaitForMultipleObjects\(2\s*,\s*initializationEvents/,
  'initialization waits for the window-ready signal separately from the user action',
);
assert.match(
  initialize,
  /if\s*\(wait\s*!=\s*WAIT_OBJECT_0\)\s*\{[\s\S]*?HANDLE userActionEvents\[\]\s*=\s*\{\s*gExitEvent\s*,\s*gStartEvent\s*\};\s*wait\s*=\s*WaitForMultipleObjects\(2\s*,\s*userActionEvents/,
  'a ready window remains open until the user starts or cancels setup',
);
assert.match(
  initialize,
  /if\s*\(wait\s*!=\s*WAIT_OBJECT_0\s*\+\s*1\)\s*\{[\s\S]*?UINT propertyResult\s*=\s*MsiSetPropertyW/,
  'the MSI install properties are set only after the user starts setup',
);
assert.doesNotMatch(
  initialize,
  /HANDLE initializationEvents\[\]\s*=\s*\{\s*gUiReadyEvent\s*,\s*gExitEvent\s*,\s*gStartEvent\s*\}/,
  'the ready signal cannot be mistaken for the user start action',
);

const messageHandlerStart = source.indexOf('case kInstallMessage: {');
const messageHandlerEnd = source.indexOf('case WM_PAINT:', messageHandlerStart);
assert.notEqual(messageHandlerStart, -1, 'embedded UI message handler exists');
assert.notEqual(messageHandlerEnd, -1, 'embedded UI message handler has a following case');
const messageHandler = source.slice(messageHandlerStart, messageHandlerEnd);
assert.match(
  messageHandler,
  /std::unique_ptr<std::wstring> detail;\s*if\s*\(wParam\s*==\s*1\s*\|\|\s*wParam\s*==\s*3\s*\|\|\s*wParam\s*==\s*4\)\s*\{\s*detail\.reset\(reinterpret_cast<std::wstring\*>\(lParam\)\);/,
  'only heap-owned text messages are interpreted and freed as strings',
);
assert.doesNotMatch(
  messageHandler,
  /delete\s+detail\s*;/,
  'numeric progress messages are never deleted as pointers',
);
assert.match(
  source,
  /SetThreadDpiAwarenessContext\(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2\)/,
  'the setup window uses per-monitor DPI awareness',
);
assert.match(
  source,
  /float ScaleForMonitor\(HMONITOR monitor, UINT dpi\)[\s\S]*?rcWork[\s\S]*?kDesignWidth[\s\S]*?kDesignHeight/,
  'window scale is capped to the monitor work area',
);
assert.match(
  source,
  /SetWindowPos\(g\.window, HWND_BOTTOM[\s\S]*?SetEvent\(gStartEvent\)/,
  'the setup window yields foreground Z-order before Windows Installer may request elevation',
);
assert.match(
  source,
  /if\s*\(message\s*==\s*INSTALLMESSAGE_INSTALLSTART\)\s*\{\s*if\s*\(HWND window\s*=\s*gUiWindow\.load\(\)\)\s*PostMessageW\(window,\s*kRestoreInstallerWindow/,
  'the setup window returns to the foreground after the elevation transition',
);
assert.match(
  source,
  /case WM_ERASEBKGND:\s*[\s\S]*?return 1;/,
  'background erase is suppressed between progress paints',
);
assert.match(
  source,
  /case kInstallMessage:\s*\{[\s\S]*?InvalidateRect\(window,\s*nullptr,\s*FALSE\);/,
  'MSI progress updates do not erase the whole window before repainting',
);
assert.match(
  source,
  /Gdiplus::Bitmap frame\(width, height, PixelFormat32bppPARGB\)[\s\S]*?target\.DrawImage\(&frame, 0, 0\)/,
  'the installer surface is drawn off-screen and copied to the window in one frame',
);

console.log('Windows MSI embedded UI startup, progress ownership, DPI, elevation foreground, and flicker contracts passed.');
