'use strict';
// Offline logic tests (no network, no native deps): parsers, truncation, config resolution, scheduler validation.
const assert = require('assert');
process.env.TEST_KEY = 'secret';
const { truncateChat, parseReason, resolveEnv } = require('../core/util');
const { parse } = require('../modules/ai-chat');
const { parseDecision } = require('../modules/ai-brain');
const { mask } = require('../modules/proxy');

assert.strictEqual(resolveEnv('ENV:TEST_KEY'), 'secret');
assert.strictEqual(resolveEnv('ENV:NOPE_X|fallback'), 'fallback');
assert.deepStrictEqual(resolveEnv({ a: ['ENV:TEST_KEY'] }), { a: ['secret'] });

assert.strictEqual(parse('.ai').kind, 'help');
assert.strictEqual(parse('test .ai what is your name').question, 'what is your name');
assert.strictEqual(parse('.AI Hello').question, 'Hello');
assert.strictEqual(parse('hello .airplane').kind, 'none');

assert.ok(truncateChat('word '.repeat(200), 256).length <= 256);
assert.strictEqual(truncateChat('a\nb'), 'a b');
assert.strictEqual(parseReason('{"text":"Flying","extra":[{"text":" is not allowed"}]}'), 'Flying is not allowed');

assert.strictEqual(parseDecision('```json\n{"action":"idle"}\n```').action, 'idle');
assert.throws(() => parseDecision('{"action":"explode"}'));
assert.strictEqual(parseDecision('{"action":"explore","params":{"steps":2}}').action, 'explore');
assert.strictEqual(parseDecision('{"action":"loot","params":{"radius":8}}').action, 'loot');

assert.strictEqual(mask('socks5://u:pw@h:1080'), 'socks5://u:***@h:1080');
console.log('selftest: all assertions passed');
