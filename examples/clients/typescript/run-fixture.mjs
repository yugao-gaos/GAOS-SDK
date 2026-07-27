import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const state = { acknowledged: [] };
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
  } else if (message.type === 'patch') {
    if (message.baseTransitionRevision !== state.transitionRevision) {
      throw new Error('patch base does not match durable state');
    }
    Object.assign(state, {
      transitionRevision: message.transitionRevision,
      tick: message.tick,
      entityId: message.patch.entityId,
      x: message.patch.x,
      y: message.patch.y,
    });
  } else if (message.type === 'acknowledgement') {
    state.acknowledged.push(message.submissionId);
  }
}
process.stdout.write(`${JSON.stringify(state)}\n`);
