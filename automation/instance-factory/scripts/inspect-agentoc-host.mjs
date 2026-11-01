#!/usr/bin/env node
import { inspectAgentoCHost } from '../../../lib/instance-factory-command.mjs';

const report = await inspectAgentoCHost();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
