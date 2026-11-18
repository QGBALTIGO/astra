/** Z85 transports the compressed, hash-verified bundle within Railway's 96 KiB limit.
 * The alphabet and published test vector follow https://rfc.zeromq.org/spec/32/.
 * Encoding is only for the release artifact; browsers receive the original asset bytes.
 */
export const z85Alphabet =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';

export function encodeZ85(bytes) {
  if (bytes.length % 4) throw new Error('Z85 input must be padded to four bytes');
  const output = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value = bytes.readUInt32BE(offset);
    const digits = new Array(5);
    for (let digit = 4; digit >= 0; digit--) {
      digits[digit] = z85Alphabet[value % 85];
      value = Math.floor(value / 85);
    }
    output.push(digits.join(''));
  }
  return output.join('');
}

export function decodeZ85(text) {
  if (text.length % 5) throw new Error('Invalid Z85 length');
  const output = Buffer.alloc((text.length / 5) * 4);
  for (let offset = 0; offset < text.length; offset += 5) {
    let value = 0;
    for (let digit = 0; digit < 5; digit++) {
      const number = z85Alphabet.indexOf(text[offset + digit]);
      if (number < 0) throw new Error('Invalid Z85 character');
      value = value * 85 + number;
    }
    if (value > 0xffffffff) throw new Error('Invalid Z85 group');
    output.writeUInt32BE(value, (offset / 5) * 4);
  }
  return output;
}
