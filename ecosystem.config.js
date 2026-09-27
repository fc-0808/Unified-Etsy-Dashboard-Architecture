'use strict';

/**
 * PM2 process definition for the Unified Etsy Dashboard.
 *
 * PM2 supervises one dashboard process (which embeds receipt-sync + auto-restock)
 * and an isolated Tailscale Funnel watchdog, keeping both app and public route
 * healthy 24/7:
 *   - auto-restarts on crash or if memory balloons
 *   - restarts with backoff so a flapping crash doesn't hammer Etsy
 *   - writes rotating logs under data/logs/
 *   - resurrects automatically on machine login (see scripts/install-autostart.ps1)
 *
 * Usage:
 *   npm run auto:start     # start under PM2 + persist process list
 *   npm run auto:status    # see status / uptime / restarts
 *   npm run auto:logs      # tail live logs
 *   npm run auto:stop      # stop the managed process
 */
const path = require('path');
const { resolveDashboardNode } = require('./src/server/system-node');

const dashboardNode = resolveDashboardNode();

module.exports = {
  apps: [
    {
      name: 'etsy-dashboard',
      script: path.join(__dirname, 'src', 'server', 'index.js'),
      cwd: __dirname,
      // Pin the system Node binary. Cursor agent shells expose Node 24 on PATH;
      // using that interpreter crashes better-sqlite3 built for Node 22.
      interpreter: dashboardNode,

      // One instance — the embedded scheduler must not run in parallel copies
      // (that would double Etsy API usage).
      instances: 1,
      exec_mode: 'fork',

      // Resilience
      autorestart: true,
      min_uptime: '30s',          // must stay up 30s to count as a healthy start
      max_restarts: 15,           // within min_uptime window before giving up
      restart_delay: 5000,        // base delay between restarts
      exp_backoff_restart_delay: 2000, // exponential backoff on repeated crashes
      max_memory_restart: '1536M', // headroom for base64 vision image payloads; restart only on a real leak

      watch: false,               // never auto-restart on file changes in prod

      // Logging
      time: true,                 // prefix every log line with a timestamp
      merge_logs: true,
      out_file: path.join(__dirname, 'data', 'logs', 'dashboard-out.log'),
      error_file: path.join(__dirname, 'data', 'logs', 'dashboard-err.log'),

      env: {
        NODE_ENV: 'production',
        EMBEDDED_SYNC: '1',       // run order sync + auto-restock inside this process
      },
    },
    {
      // The Tailscale service persists Funnel configuration, but a network-
      // adapter/VPN transition can leave public ingress stale while private
      // MagicDNS still works. This independent, low-footprint supervisor checks
      // the actual public relay path and performs one guarded reconnect only
      // after two consecutive failures. It never enables an intentionally
      // disabled Funnel.
      name: 'etsy-funnel-watchdog',
      script: path.join(__dirname, 'scripts', 'funnel.js'),
      args: ['--watch'],
      cwd: __dirname,
      interpreter: dashboardNode,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 15,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '128M',
      watch: false,
      time: true,
      merge_logs: true,
      out_file: path.join(__dirname, 'data', 'logs', 'funnel-watchdog-out.log'),
      error_file: path.join(__dirname, 'data', 'logs', 'funnel-watchdog-err.log'),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
