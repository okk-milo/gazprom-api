/* global Buffer, console, process */
// Run in a child process: the old parser's assertion bypasses promise catches.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fetch, Agent } from 'undici';

async function main() {
  const mode = process.argv[2] ?? 'eof';
  const body = Buffer.alloc(64 * 1024, 0x61);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      const chunked = mode.includes('chunked');
      const length = mode.includes('length');
      const framing = chunked
        ? 'Transfer-Encoding: chunked\r\n'
        : length
          ? `Content-Length: ${body.length + (mode.startsWith('truncated') ? 1 : 0)}\r\n`
          : '';
      socket.write(`HTTP/1.1 200 OK\r\n${framing}Connection: close\r\n\r\n`);
      if (chunked) socket.write(`${body.length.toString(16)}\r\n`);
      socket.write(body);
      if (chunked && !mode.startsWith('truncated')) socket.write('\r\n0\r\n\r\n');
      socket.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = new Agent({ bodyTimeout: 2000 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      dispatcher: agent,
    });
    // Deliberately pause while FIN arrives, as when the API is awaiting the LLM.
    await delay(300);
    if (mode.startsWith('truncated')) {
      await assert.rejects(response.arrayBuffer());
      console.log(JSON.stringify({ mode, expectedTruncation: true, processAlive: true }));
    } else {
      const received = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(received, body);
      console.log(JSON.stringify({ mode, bytes: received.length, processAlive: true }));
    }
  } finally {
    await agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
