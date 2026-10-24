// Run: node scripts/net-check.ts
// Not connected yet (or reconnecting) must not look like "this relay has no older history" (#8 review):
// the scroll-up loader stops for good on that answer, but retries on a rejection.
import assert from 'node:assert/strict';
import { connect } from '../src/net.ts';

const net = connect('ws://127.0.0.1:9', {}, () => 0, { onReady() {}, onMsg() {}, onSignal() {}, onState() {} });
await assert.rejects(net.older(1), /offline/, 'before ready');
await new Promise((r) => setTimeout(r, 300)); // the socket fails and waits to reconnect
await assert.rejects(net.older(1), /offline/, 'while reconnecting');

console.log('net ok');
process.exit(0); // the reconnect timer would keep running
