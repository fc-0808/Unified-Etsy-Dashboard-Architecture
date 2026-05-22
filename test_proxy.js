const { SocksClient } = require('socks');
const tls = require('tls');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// Parse "socks5://user:pass@host:port" into an object the socks library understands
function parseProxy(url) {
    const u = new URL(url);
    return {
        ipaddress: u.hostname,
        port: parseInt(u.port),
        type: 5,
        userId: u.username,
        password: u.password
    };
}

// Make an HTTPS GET through a chain of two SOCKS5 proxies:
//   local VPN (bypasses GFW) -> IPFoxy (provides the static HK exit IP)
async function getViaTunnel(targetHost, targetPath) {
    const proxyUrl = config.test_group.proxy;
    const vpnPort  = config.vpn_local_port || 7897;

    const { socket } = await SocksClient.createConnectionChain({
        proxies: [
            { ipaddress: '127.0.0.1', port: vpnPort, type: 5 },
            parseProxy(proxyUrl)
        ],
        destination: { host: targetHost, port: 443 },
        command: 'connect'
    });

    const tlsSocket = tls.connect({ socket, servername: targetHost });
    await new Promise((res, rej) => {
        tlsSocket.on('secureConnect', res);
        tlsSocket.on('error', rej);
    });

    tlsSocket.write(
        `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`
    );

    return new Promise((res, rej) => {
        let raw = '';
        tlsSocket.on('data', c => raw += c);
        tlsSocket.on('end', () => {
            try { res(JSON.parse(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'))); }
            catch { res(raw); }
        });
        tlsSocket.on('error', rej);
    });
}

async function main() {
    console.log('='.repeat(55));
    console.log(' IPFoxy Proxy PoC — Tunnel Chain Test');
    console.log('='.repeat(55));

    // Step 1 — real home IP (no proxy)
    let homeIp = 'unknown';
    try {
        const r = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
        homeIp = r.data.ip;
    } catch { /* non-fatal */ }

    console.log(`\n  Your outbound IP (through local VPN): ${homeIp}`);

    // Step 2 — IP seen through the full chain
    console.log('\n  Testing chain: local VPN (7897) -> IPFoxy (45001) -> internet...');
    try {
        const result = await getViaTunnel('api.ipify.org', '/?format=json');
        const exitIp = result.ip;

        console.log(`  IPFoxy exit IP seen by the internet  : ${exitIp}`);

        if (exitIp === homeIp) {
            console.log('\n  WARNING: IPs are the same — proxy chain is not working.');
        } else {
            console.log('\n  SUCCESS: IPs differ — network isolation confirmed.');
            console.log('  The internet sees your static Hong Kong IPFoxy IP.');
            console.log('  Core tunnel engine is working. Ready to build on top of this.');
        }
    } catch (e) {
        console.error('\n  FAILED:', e.message);
        console.error('\n  Check:');
        console.error('  1. Is your VPN (饿饭加速器) connected?');
        console.error('  2. Is the IPFoxy proxy string correct in config.json?');
        console.error('  3. Is your IPFoxy subscription active?');
    }

    console.log('\n' + '='.repeat(55));
}

main();
