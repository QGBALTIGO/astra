import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeZ85, decodeZ85 } from '../transport.mjs';

test('Z85 agrees with the independent published ZeroMQ vector', () => {
  const bytes = Buffer.from('864fd26fb559f75b', 'hex');
  assert.equal(encodeZ85(bytes), 'HelloWorld');
  assert.deepEqual(decodeZ85('HelloWorld'), bytes);
  assert.equal(encodeZ85(Buffer.alloc(4)), '00000');
});

test('transport preserves every byte value and rejects malformed frames', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  assert.deepEqual(decodeZ85(encodeZ85(bytes)), bytes);
  assert.throws(() => encodeZ85(Buffer.from([1, 2, 3])), /padded/);
  assert.throws(() => decodeZ85('1234'), /length/);
  assert.throws(() => decodeZ85('~~~~~'), /character/);
  assert.throws(() => decodeZ85('#####'), /group/);
});
