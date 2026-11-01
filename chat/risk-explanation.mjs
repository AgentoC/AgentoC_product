/**
 * chat/risk-explanation.mjs — 人话解释层（模板优先，纯逻辑，无 I/O）。
 *
 * 本模块用确定性事实 + reason code 生成审批所需的中文说明
 * （summary / reason / saferAlternative），永远不能改变 risk tier。
 */

import { parseCommandFacts } from './command-parser.mjs';
import { classifyRisk } from './risk-classifier.mjs';
import { codeForReason, RISK_REASON_CODES } from './risk-policy.mjs';

const R = RISK_REASON_CODES;

const TEMPLATES = {
  [R.DELETE_FILESYSTEM_ROOT]: {
    summary: '删除文件系统根目录',
    reason: '将递归删除根目录 / 下的几乎所有文件，不可恢复',
    saferAlternative: '立即终止；执行前务必确认目标',
  },
  [R.DELETE_SYSTEM_PATH]: {
    summary: '删除系统路径下的文件',
    reason: '目标位于系统目录，可能破坏系统或服务',
    saferAlternative: '先列出目标内容，确认无误后再删除',
  },
  [R.DELETE_GIT_METADATA]: {
    summary: '删除 .git 仓库元数据',
    reason: '将删除版本历史，不可恢复',
    saferAlternative: '先备份 .git 目录',
  },
  [R.DELETE_PROJECT_ROOT]: {
    summary: '删除项目根目录',
    reason: '将删除整个项目目录',
    saferAlternative: '先备份项目',
  },
  [R.DELETE_HOME_ROOT]: {
    summary: '删除用户主目录',
    reason: '将删除主目录下全部内容，不可恢复',
    saferAlternative: '立即终止并先备份',
  },
  [R.DELETE_GLOB_PATTERN]: {
    summary: '递归删除通配符匹配的多个文件',
    reason: '通配符匹配范围无法在执行前完全确定',
    saferAlternative: '先执行 ls/find 查看匹配结果再删除',
  },
  [R.DELETE_VARIABLE_TARGET]: {
    summary: '递归删除变量指向的目录',
    reason: '变量值不确定，实际删除范围不可预知',
    saferAlternative: '先 echo 变量确认实际值',
  },
  [R.DELETE_NO_TARGET]: {
    summary: '删除命令缺少明确目标',
    reason: '可能因参数展开失败产生意外行为',
    saferAlternative: '检查参数，补全明确目标',
  },
  [R.DELETE_FIND_BATCH]: {
    summary: '用 find 批量删除文件',
    reason: '批量删除范围较大，且基于匹配规则',
    saferAlternative: '先 find -print 查看清单再删除',
  },
  [R.DELETE_HOME]: {
    summary: '删除主目录下文件',
    reason: '目标在项目外，属于用户个人目录',
    saferAlternative: '确认目标文件无误',
  },
  [R.DELETE_IN_PROJECT]: {
    summary: '删除项目内文件',
    reason: '项目内常规删除',
    saferAlternative: '',
  },
  [R.DELETE_RECURSIVE_PROJECT]: {
    summary: '递归删除项目内目录',
    reason: '递归删除范围较大',
    saferAlternative: '先查看目录内容',
  },
  [R.DELETE_TEMP_FILE]: {
    summary: '删除临时文件',
    reason: '临时目录内常规删除',
    saferAlternative: '',
  },
  [R.DELETE_RECURSIVE_TEMP]: {
    summary: '递归删除临时目录中的文件',
    reason: '目标目录可能包含多个文件，删除范围需要确认',
    saferAlternative: '先 find 列出匹配文件再删除',
  },
  [R.DELETE_UNRESOLVABLE]: {
    summary: '删除无法解析路径的目标',
    reason: '目标位置不明确，无法确定删除范围',
    saferAlternative: '确认完整路径',
  },
  [R.DELETE_MULTI_TARGET]: {
    summary: '批量删除多个文件',
    reason: '一次删除多个目标',
    saferAlternative: '核对文件列表',
  },
  [R.DELETE_RMDIR]: {
    summary: '删除空目录',
    reason: '仅删除空目录，无数据损失',
    saferAlternative: '',
  },
  [R.DESTRUCTIVE_ERASE]: {
    summary: '执行不可恢复的数据销毁',
    reason: '该程序会无条件销毁数据',
    saferAlternative: '立即确认备份后再执行',
  },
  [R.FILE_EDIT_SYSTEM_PATH]: {
    summary: '写入系统路径',
    reason: '修改系统级文件可能影响系统运行',
    saferAlternative: '确认修改内容与影响',
  },
  [R.FILE_EDIT_PROJECT]: {
    summary: '编辑项目内文件',
    reason: '项目内常规文件编辑',
    saferAlternative: '',
  },
  [R.FILE_EDIT_OUTSIDE_PROJECT]: {
    summary: '编辑项目外文件',
    reason: '目标不在当前项目内',
    saferAlternative: '确认目标文件',
  },
  [R.INSTALL_IN_SCOPE_AUTO]: {
    summary: '安装系统软件包',
    reason: '受控范围内的自动安装，以特权执行器运行',
    saferAlternative: '',
  },
  [R.INSTALL_SUDO]: {
    summary: 'sudo 安装软件包',
    reason: '以 root 权限安装，改变系统状态',
    saferAlternative: '确认包来源与版本',
  },
  [R.INSTALL_OUT_OF_SCOPE]: {
    summary: '安装软件包',
    reason: '安装范围超出自动放行白名单（语言包管理器/项目外）',
    saferAlternative: '确认包来源',
  },
  [R.PRIVILEGE_ESCALATION]: {
    summary: 'sudo 提权执行',
    reason: '以 root 权限运行非只读命令',
    saferAlternative: '确认命令影响范围',
  },
  [R.SUDO_SCRIPT_INTERPRETER]: {
    summary: 'sudo 运行脚本解释器',
    reason: '以 root 权限执行任意内嵌代码',
    saferAlternative: '确认脚本内容后再执行',
  },
  [R.SUDO_SYSTEM_ADMIN]: {
    summary: 'sudo 系统管理操作',
    reason: '修改系统服务或系统状态',
    saferAlternative: '确认服务名与影响',
  },
  [R.SUDO_SERVICE_CONTROL]: {
    summary: 'sudo 服务控制',
    reason: '修改服务运行状态',
    saferAlternative: '确认服务名与影响',
  },
  [R.DECLARED_PRIVILEGED_OP]: {
    summary: '声明的特权操作',
    reason: 'Agent 声明此操作需要特权执行',
    saferAlternative: '确认操作内容',
  },
  [R.GIT_CLEAN_FORCE]: {
    summary: '强制清理未跟踪文件',
    reason: '将删除未跟踪/被忽略文件，不可恢复',
    saferAlternative: '先 git status / git clean -n 查看',
  },
  [R.GIT_CLEAN_UNFORCED]: {
    summary: '清理未跟踪文件（未强制）',
    reason: '清理工作区未跟踪文件',
    saferAlternative: '先 git status 查看',
  },
  [R.GIT_PUSH_FORCE]: {
    summary: '强制推送或删除远程分支',
    reason: '将重写远程历史，影响协作方',
    saferAlternative: '优先 --force-with-lease 或先备份分支',
  },
  [R.GIT_REMOTE_OPERATION]: {
    summary: 'git 远程操作',
    reason: '会与远程仓库通信',
    saferAlternative: '',
  },
  [R.SYSTEM_PATH_WRITE]: {
    summary: '写入系统路径',
    reason: '修改系统目录内容可能影响系统',
    saferAlternative: '确认修改内容',
  },
  [R.SENSITIVE_SYSTEM_READ]: {
    summary: '读取敏感系统文件',
    reason: '文件包含密钥或根策略，读取即敏感',
    saferAlternative: '确认为排障/审计必要操作',
  },
  [R.SHELL_CONTROL_SYSTEM_PATH]: {
    summary: '循环/条件读取系统路径',
    reason: '循环体内真实命令无法静态分析',
    saferAlternative: '拆开逐步执行',
  },
  [R.SHELL_CONTROL_DESTRUCTIVE]: {
    summary: '循环/条件中包含破坏性命令',
    reason: '循环体内可能执行删除或提权',
    saferAlternative: '检查循环体内容',
  },
  [R.NETWORK_EGRESS]: {
    summary: '访问外部网络',
    reason: '命令会与外部网络通信',
    saferAlternative: '',
  },
  [R.INTERPRETER_DESTRUCTIVE_KEYWORD]: {
    summary: '解释器内检测到破坏性调用',
    reason: '脚本内调用删除类 API',
    saferAlternative: '确认脚本内容',
  },
  [R.SCRIPT_INTERPRETER_DESTRUCTIVE]: {
    summary: '脚本内包含危险删除',
    reason: '内嵌脚本删除系统/根/通配符目标',
    saferAlternative: '确认脚本内容',
  },
  [R.SCRIPT_INTERPRETER_SUDO]: {
    summary: '脚本内包含 sudo 提权',
    reason: '内嵌脚本以 root 执行命令',
    saferAlternative: '确认脚本内容',
  },
  [R.SCRIPT_INTERPRETER_DELETE]: {
    summary: '脚本内执行删除',
    reason: '内嵌脚本包含删除操作',
    saferAlternative: '确认脚本内容',
  },
  [R.SCRIPT_INTERPRETER_SYSTEM_PATH]: {
    summary: '脚本内写入系统路径',
    reason: '内嵌脚本修改系统目录内容',
    saferAlternative: '确认脚本内容',
  },
  [R.SCRIPT_INTERPRETER_FORCE_PUSH]: {
    summary: '脚本内强制推送',
    reason: '内嵌脚本重写远程历史',
    saferAlternative: '确认脚本内容',
  },
  [R.SCRIPT_INTERPRETER_DOWNLOAD_EXEC]: {
    summary: '脚本内下载并执行',
    reason: '内嵌脚本从远程拉取代码直接运行',
    saferAlternative: '先检查脚本内容',
  },
  [R.SCRIPT_INTERPRETER_NESTED]: {
    summary: '嵌套脚本解释器',
    reason: '解释器内再套解释器，静态分析受限',
    saferAlternative: '拆开逐步执行',
  },
  [R.DOWNLOAD_AND_EXECUTE]: {
    summary: '下载并执行远程脚本',
    reason: '远程不可信代码将直接在本机运行',
    saferAlternative: '先下载并检查脚本内容再执行',
  },
  [R.FIND_EXEC_DESTRUCTIVE]: {
    summary: 'find 批量执行破坏性程序',
    reason: '对匹配文件批量执行删除类程序',
    saferAlternative: '先 find -print 查看清单',
  },
  [R.FIND_EXEC_BATCH]: {
    summary: 'find 批量执行命令',
    reason: '对匹配文件批量执行命令，范围较大',
    saferAlternative: '先 find -print 查看清单',
  },
  [R.XARGS_DESTRUCTIVE]: {
    summary: 'xargs 批量执行破坏性程序',
    reason: '对列表输入批量执行删除类程序',
    saferAlternative: '先查看输入列表',
  },
  [R.XARGS_BATCH]: {
    summary: 'xargs 批量执行命令',
    reason: '对列表输入批量执行命令',
    saferAlternative: '先查看输入列表',
  },
  [R.COMPOSITE_UNANALYZED]: {
    summary: '组合命令（多步骤操作）',
    reason: '命令串联了多个步骤，部分行为无法静态确认',
    saferAlternative: '拆成单条命令逐步确认后再执行',
  },
  [R.UNKNOWN_COMMAND]: {
    summary: '无法识别的命令',
    reason: '这个程序不在已知列表里，具体行为不明确',
    saferAlternative: '确认命令来源，必要时先查看帮助再执行',
  },
  [R.ORDINARY_COMMAND]: {
    summary: '执行常规命令',
    reason: '',
    saferAlternative: '',
  },
  [R.NO_COMMAND]: {
    summary: '无命令',
    reason: '',
    saferAlternative: '',
  },
};

const DANGER_FALLBACK = {
  summary: '高风险操作',
  reason: '该操作风险较高，需要确认',
  saferAlternative: '确认操作影响范围',
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstReasonCode(reasons) {
  const first = Array.isArray(reasons) ? reasons[0] : null;
  if (!first) return '';
  if (typeof first === 'string') return codeForReason(first);
  if (first && typeof first === 'object') return trimString(first.code) || codeForReason(first.message);
  return '';
}

// 从结构化 facts 推导展示用 reason code（reasons 未传入时兜底）。
// 只是展示映射，不参与 tier 判定；删除目标作用域按“最严重者优先”。
function codeFromFacts(facts, depth = 0) {
  if (!facts || depth > 2) return '';
  if (facts.downloadAndExecute) return R.DOWNLOAD_AND_EXECUTE;
  if (facts.findExecDestructive) return R.FIND_EXEC_DESTRUCTIVE;
  if (facts.findExec) return R.FIND_EXEC_BATCH;
  if (facts.xargsDestructive) return R.XARGS_DESTRUCTIVE;
  if (facts.xargs) return R.XARGS_BATCH;
  if (facts.forcePush) return R.GIT_PUSH_FORCE;
  if (facts.gitCleanForced) return R.GIT_CLEAN_FORCE;
  if (facts.category === 'destructive_delete') {
    if (facts.dangerDelete) {
      if (facts.targetScopes.includes('root')) return R.DELETE_FILESYSTEM_ROOT;
      if (facts.targetScopes.includes('system')) return R.DELETE_SYSTEM_PATH;
      if (facts.targetScopes.includes('git-metadata')) return R.DELETE_GIT_METADATA;
      if (facts.targetScopes.includes('project-root')) return R.DELETE_PROJECT_ROOT;
      if (facts.targetScopes.includes('home-root')) return R.DELETE_HOME_ROOT;
      if (facts.glob) return R.DELETE_GLOB_PATTERN;
      if (facts.variable) return R.DELETE_VARIABLE_TARGET;
    }
    if (facts.deleteTargets.length === 0) return R.DELETE_NO_TARGET;
    if (facts.recursive && facts.targetScopes.includes('temp')) return R.DELETE_RECURSIVE_TEMP;
    if (facts.recursive && facts.targetScopes.includes('inside-project')) return R.DELETE_RECURSIVE_PROJECT;
    if (facts.targetScopes.includes('temp')) return R.DELETE_TEMP_FILE;
    if (facts.targetScopes.includes('inside-project')) return R.DELETE_IN_PROJECT;
    if (facts.targetScopes.includes('inside-home') || facts.targetScopes.includes('home-root')) return R.DELETE_HOME;
    if (facts.deleteTargets.length > 1) return R.DELETE_MULTI_TARGET;
    return R.DELETE_UNRESOLVABLE;
  }
  if (facts.sensitiveSystemPath) return R.SENSITIVE_SYSTEM_READ;
  if (facts.systemPath && facts.sudo) return R.SYSTEM_PATH_WRITE;
  if (facts.scriptInterpreter && facts.innerCommand) {
    const innerFacts = parseCommandFacts(facts.innerCommand, {});
    return codeFromFacts(innerFacts, depth + 1);
  }
  if (facts.network) return R.NETWORK_EGRESS;
  if (facts.sudo) return R.PRIVILEGE_ESCALATION;
  if (facts.complex) return R.COMPOSITE_UNANALYZED;
  if (facts.unknownProgram) return R.UNKNOWN_COMMAND;
  return R.ORDINARY_COMMAND;
}

// 复合命令的半结构化摘要：利用段级解析给出步数与高风险步计数，
// 替代纯技术化的"未完全解析"文案（reason-code 契约保持不变）。
function compositeSegmentSummary(segments) {
  const risky = segments.filter((segment) => (
    segment.dangerDelete
    || segment.downloadAndExecute
    || segment.forcePush
    || segment.findExecDestructive
    || segment.xargsDestructive
    || segment.destructiveKeyword
    || segment.sudo
  ));
  const parts = [`包含 ${segments.length} 步操作`];
  if (risky.length > 0) parts.push(`其中 ${risky.length} 步涉及删除/提权等高风险行为`);
  return parts.join('，');
}

/**
 * 模板优先的基础人话说明。任何命令都能出模板，简单命令不再触发 LLM。
 * @param {object} input
 * @param {string} [input.command]
 * @param {string} [input.cwd]
 * @param {string} [input.projectRoot]
 * @param {string} [input.home]
 * @param {string} [input.tier]
 * @param {Array}  [input.reasons]  [{code,message}] 或字符串数组
 * @returns {{summary:string, reason:string, saferAlternative:string, source:string, code:string, tier:string, facts:object|null}}
 */
export function templateExplanation({ command, cwd, projectRoot, home, tier, reasons } = {}) {
  const facts = parseCommandFacts(command, { cwd, projectRoot, home });
  const code = firstReasonCode(reasons) || codeFromFacts(facts);
  const template = TEMPLATES[code]
    || (tier === 'danger' || facts?.downloadAndExecute ? DANGER_FALLBACK : TEMPLATES[R.ORDINARY_COMMAND]);
  const segments = Array.isArray(facts?.segments) && facts.segments.length > 0 ? facts.segments : null;
  return {
    summary: code === R.COMPOSITE_UNANALYZED && segments
      ? compositeSegmentSummary(segments)
      : template.summary,
    reason: template.reason,
    saferAlternative: template.saferAlternative,
    source: 'template',
    code,
    tier: tier || '',
    facts,
  };
}

/**
 * Snapshot deterministic approval copy at the permission boundary. Activity
 * projection must never call this helper, and this helper never changes the
 * classifier or approval decision.
 */
export function explanationForApproval({ command, cwd, projectRoot, home } = {}) {
  const text = String(command || '').trim();
  if (!text) return null;
  const risk = classifyRisk({ command: text, cwd, projectRoot, home });
  const template = templateExplanation({
    command: text,
    cwd,
    projectRoot,
    home,
    tier: risk.tier || '',
    reasons: risk.reasons,
  });
  return {
    summary: template.summary,
    reason: template.reason,
    saferAlternative: template.saferAlternative,
  };
}
