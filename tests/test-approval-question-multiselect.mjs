import assert from 'node:assert/strict';
import { approvalRequestEvent } from '../chat/normalizer.mjs';

const event = approvalRequestEvent({ approvalId: 'q', questions: [
  { question: 'Choose several', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] },
  { question: 'Choose one', multiSelect: false, options: [{ label: 'Three' }] },
  { question: 'Alias', isMultiSelect: true },
] });
assert.deepEqual(event.questions.map(question => question.multiSelect), [true, false, true]);
