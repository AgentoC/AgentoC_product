#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const templateSource = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static', 'chat', 'i18n.js'), 'utf8');
const inputCssSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-input.css'), 'utf8');

const uploadButtonIndex = templateSource.indexOf('id="imgBtn"');
const textareaIndex = templateSource.indexOf('id="msgInput"');
const configRowIndex = templateSource.indexOf('class="input-config-row"');
const wrapperIndex = templateSource.indexOf('class="input-wrapper"');
const actionsRowIndex = templateSource.indexOf('class="input-actions-row"');

assert.notEqual(uploadButtonIndex, -1, 'chat template should include the upload button');
assert.notEqual(textareaIndex, -1, 'chat template should include the message composer textarea');
assert.notEqual(configRowIndex, -1, 'chat template should include the inline tooling row');
assert.notEqual(wrapperIndex, -1, 'chat template should include the composer shell');
assert.notEqual(actionsRowIndex, -1, 'chat template should include a dedicated composer action row');
assert.ok(configRowIndex < wrapperIndex, 'tooling controls should sit above the composer shell instead of inside the textarea frame');
assert.ok(textareaIndex < actionsRowIndex, 'composer actions should render below the textarea in a stacked layout');
assert.ok(textareaIndex < uploadButtonIndex, 'upload button should no longer reduce textarea width by rendering before the input text');

assert.match(templateSource, /class="composer-action-btn composer-action-btn--upload" id="imgBtn"/, 'upload button should keep the dedicated composer action styling');
assert.match(templateSource, /<span class="img-btn-label sr-only" data-i18n="action\.add">Add<\/span>/, 'plus button should keep an accessible label even in the icon-only layout');
assert.match(templateSource, /aria-haspopup="menu" aria-expanded="false" aria-controls="composerAddMenu"/, 'plus button should open the composer add menu');
assert.match(templateSource, /title="Add" aria-label="Add" data-i18n-title="action\.add" data-i18n-aria-label="action\.add"/, 'plus button should describe the add menu');
assert.match(templateSource, /<span class="img-btn-icon" data-icon="plus" aria-hidden="true"><\/span>/, 'upload button should render as a plus icon in the composer action row');
assert.match(templateSource, /id="composerAttachFilesBtn"[\s\S]*data-i18n="compose\.add\.files">Files and folders/, 'add menu should include the file attachment entry');
assert.match(templateSource, /id="composerPlanMenuItem"[\s\S]*data-i18n="compose\.add\.plan">Plan mode/, 'add menu should include the plan mode entry');
assert.match(templateSource, /id="composerPlanChip"/, 'composer should include a plan chip for active plan mode');
assert.match(templateSource, /id="composerPermissionBtn"[\s\S]*aria-controls="composerPermissionMenu"/, 'composer should include a visible permission mode button');
assert.match(templateSource, /id="composerPermissionOptions"/, 'composer should include a permission mode menu option container');

const sendButtonCssMatch = inputCssSource.match(/\.send-btn\s*\{[\s\S]*?\n\}/);
assert.ok(sendButtonCssMatch, 'chat input styles should define the send button');
assert.doesNotMatch(sendButtonCssMatch[0], /margin-left:\s*auto/, 'send button should not split runtime and voice controls away from the right edge');

assert.match(i18nSource, /"action\.add": "Add"/, 'english UI copy should label the plus menu as Add');
assert.match(i18nSource, /"action\.upload": "Upload"/, 'english UI copy should label the control as Upload');
assert.match(i18nSource, /"action\.attachFiles": "Attach files"/, 'english accessibility copy should describe file uploads clearly');
assert.match(i18nSource, /"compose\.add\.plan": "Plan mode"/, 'english UI copy should label plan mode in the add menu');
assert.match(i18nSource, /"compose\.permission\.mode\.fullAccess": "Full access"/, 'english UI copy should label full access permission mode');
assert.match(i18nSource, /"action\.add": "添加"/, 'chinese UI copy should label the plus menu as 添加');
assert.match(i18nSource, /"action\.upload": "上传"/, 'chinese UI copy should label the control as 上传');
assert.match(i18nSource, /"action\.attachFiles": "上传文件"/, 'chinese accessibility copy should describe file uploads clearly');
assert.match(i18nSource, /"compose\.add\.plan": "Plan 模式"/, 'chinese UI copy should label plan mode in the add menu');
assert.match(i18nSource, /"compose\.permission\.mode\.fullAccess": "完整权限"/, 'chinese UI copy should label full access permission mode');

console.log('test-chat-upload-button: ok');
