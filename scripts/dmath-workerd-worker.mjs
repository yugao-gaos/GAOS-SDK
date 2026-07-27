import { createDmath } from '../dist/engine/dmath.js';

const dmath = createDmath();

function bits(value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export default {
  async fetch(request) {
    const vectors = await request.json();
    const actual = vectors.map((vector) => {
      const args = vector.args.map((value) => value === '-0' ? -0 : value);
      let result;
      if (vector.function === 'atan2') result = dmath.atan2(args[0], args[1]);
      else if (vector.function === 'clamp') result = dmath.clamp(args[0], args[1], args[2]);
      else if (vector.function === 'roundTo') result = dmath.roundTo(args[0], args[1]);
      else result = dmath[vector.function](args[0]);
      return bits(result);
    });
    return Response.json(actual);
  },
};
