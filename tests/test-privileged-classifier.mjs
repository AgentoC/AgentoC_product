#!/usr/bin/env node
import assert from 'assert/strict';

import {
  CATEGORY_DELETE,
  CATEGORY_INSTALL,
  CATEGORY_OTHER,
  classifyPrivilegedOperation,
  getPrivilegedCategoryTitle,
  normalizePrivilegedCategory,
} from '../chat/privileged-classifier.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

function classify(command, declaredCategory) {
  return classifyPrivilegedOperation({ command, declaredCategory });
}

// --- category normalization ---
check('install alias', normalizePrivilegedCategory('install') === CATEGORY_INSTALL);
check('rm alias -> delete', normalizePrivilegedCategory('rm') === CATEGORY_DELETE);
check('other alias', normalizePrivilegedCategory('system') === CATEGORY_OTHER);
check('garbage -> empty', normalizePrivilegedCategory('banana') === '');
check('title', getPrivilegedCategoryTitle(CATEGORY_DELETE) === 'Destructive delete');

// --- install detection + scope ---
check('apt-get install -> install', classify('apt-get install -y nginx').category === CATEGORY_INSTALL);
check('apt-get install in-scope', classify('apt-get install -y nginx').inScope === true);
check('apt install redis in-scope', classify('apt install redis-server').inScope === true);
check('snap install in-scope', classify('snap install yq').inScope === true);
check('pacman -S install', classify('pacman -S nginx').category === CATEGORY_INSTALL);
check('pacman -S in-scope', classify('pacman -S --noconfirm nginx').inScope === true);
check('sudo pacman -S in-scope', classify('sudo pacman -S --needed nginx').inScope === true);

check('--reinstall out of scope', classify('apt-get install --reinstall nginx').inScope === false);
check('local deb out of scope', classify('dpkg -i ./foo.deb').category === CATEGORY_INSTALL);
check('local deb inScope false', classify('dpkg -i ./foo.deb').inScope === false);
check('repo mutation out of scope', classify('sudo add-apt-repository ppa:x/y').inScope === false);
check('pip install deferred', classify('pip install requests').inScope === false);
check('npm install deferred', classify('npm install -g eslint').inScope === false);
check('composite out of scope', classify('apt-get install nginx && rm /tmp/x').inScope === false);
check('url arg out of scope', classify('apt-get install https://evil.example/x.deb').inScope === false);

// --- delete detection ---
check('rm -> delete', classify('rm -rf /var/log/app/*.log').category === CATEGORY_DELETE);
check('apt purge -> delete', classify('apt purge nginx').category === CATEGORY_DELETE);
check('dropdb -> delete', classify('dropdb mydb').category === CATEGORY_DELETE);
check('find -delete -> delete', classify('find /tmp -type f -delete').category === CATEGORY_DELETE);
check('npm uninstall -> delete', classify('npm uninstall eslint').category === CATEGORY_DELETE);

// --- other detection ---
check('systemctl -> other', classify('systemctl restart nginx').category === CATEGORY_OTHER);
check('mount -> other', classify('mount /dev/sda1 /mnt').category === CATEGORY_OTHER);
check('useradd -> other', classify('useradd bob').category === CATEGORY_OTHER);

// --- sudo prefix handled ---
check('sudo stripped program', classify('sudo apt-get install nginx').program === 'apt-get');
check('sudo flagged', classify('sudo rm /x').sawSudo === true);

// --- reconciliation: most restrictive wins ---
check('declared install vs rm -> delete', classify('rm -rf /x', 'install').category === CATEGORY_DELETE);
check('declared delete vs apt install -> delete', classify('apt-get install nginx', 'delete').category === CATEGORY_DELETE);
check('declared other vs apt install -> other', classify('apt-get install nginx', 'other').category === CATEGORY_OTHER);
check('override flagged on conflict', classify('rm -rf /x', 'install').override === true);
check('no override when agree', classify('apt-get install nginx', 'install').override === false);

// --- ambiguity / empty ---
check('empty command -> other low', classify('').category === CATEGORY_OTHER);
check('empty confidence low', classify('').confidence === 'low');
check('bare sudo -> other', classify('sudo').category === CATEGORY_OTHER);

console.log(`privileged-classifier: ${passed} checks passed`);
