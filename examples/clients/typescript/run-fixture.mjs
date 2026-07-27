import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const state = { acknowledged: [], rejected: [] };
let repairRequired = false;
for (const message of fixture.messages) {
  if (message.type === 'snapshot') {
    const entity = message.view.entities[0];
    Object.assign(state, {
      transitionRevision: message.transitionRevision,
      tick: message.tick,
      entityId: entity.id,
      x: entity.x,
      y: entity.y,
    });
    repairRequired = false;
  } else if (message.type === 'patch') {
    if (message.baseTransitionRevision !== state.transitionRevision) {
      repairRequired = true;
      continue;
    }
    if (repairRequired) continue;
    Object.assign(state, {
      transitionRevision: message.transitionRevision,
      tick: message.tick,
      entityId: message.patch.entityId,
      x: message.patch.x,
      y: message.patch.y,
    });
  } else if (message.type === 'acknowledgement') {
    state.acknowledged.push(message.submissionId);
  } else if (message.type === 'rejection') {
    state.rejected.push(message.submissionId);
  } else if (message.type === 'digest-mismatch') {
    repairRequired = true;
  }
}
process.stdout.write(`${JSON.stringify(state)}\n`);
