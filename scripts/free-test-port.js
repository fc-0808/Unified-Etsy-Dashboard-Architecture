'use strict';

const net = require('net');

/**
 * Ask Windows/the OS for an available loopback port instead of guessing from
 * the process ID (which can collide with listeners or reserved port ranges).
 */
function getFreeTestPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) reject(err);
        else if (!Number.isInteger(port)) reject(new Error('OS did not allocate a test port'));
        else resolve(port);
      });
    });
  });
}

module.exports = { getFreeTestPort };
