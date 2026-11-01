import assert from 'node:assert/strict';
import { scheduleLeadingTask, cancelLeadingTask } from '../chat/leading-task-scheduler.mjs';

const timers = new Map(); let nextId = 0;
const errors = [];
const options = {
  setTimer(callback, delay) { const handle = { id: ++nextId }; timers.set(handle, { callback, delay }); return handle; },
  clearTimer(handle) { timers.delete(handle); },
  onError(error) { errors.push(error.message); },
};
function tick() {
  const [handle, timer] = timers.entries().next().value;
  timers.delete(handle);
  return timer.callback();
}
const state = {}; let count = 0; let release;
const gate = new Promise(resolve => { release = resolve; });
const task = async () => { if (++count === 1) await gate; };
scheduleLeadingTask(state, task, 40, options);
const firstHandle = state.timer;
for (let n = 0; n < 1000; n++) scheduleLeadingTask(state, task, 40, options);
assert.equal(state.timer, firstHandle, 'Continuous writes cannot reset the leading timer');
assert.equal(timers.size, 1);
const running = tick();
for (let n = 0; n < 1000; n++) scheduleLeadingTask(state, task, 40, options);
assert.equal(timers.size, 0, 'Slow tasks do not accumulate waiting timers');
release(); await running;
assert.equal(timers.size, 1, 'Writes during a tick produce exactly one follow-up');
assert.equal(timers.values().next().value.delay, 0);
await tick(); assert.equal(count, 2); assert.equal(timers.size, 0);
scheduleLeadingTask(state, task, 40, options); cancelLeadingTask(state, options);
assert.equal(timers.size, 0);
scheduleLeadingTask(state, task, 40, options); assert.equal(timers.size, 0);
const failing = {};
scheduleLeadingTask(failing, async () => { throw new Error('Owned test failure'); }, 0, options);
await tick(); assert.deepEqual(errors, ['Owned test failure']); assert.equal(failing.running, false);
console.log('test-leading-task-scheduler: continuous input, bounded follow-up, cancellation and failure PASS');
