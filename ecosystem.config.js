'use strict';

/**
 * PM2 process definition for the Unified Etsy Dashboard.
 *
 * PM2 supervises the dashboard (which now embeds the receipt-sync + auto-restock
 * scheduler), so a single managed process keeps everything current 24/7:
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

module.exports = {
  apps: [
    {
      name: 'etsy-dashboard',
      script: path.join(__dirname, 'src', 'server', 'index.js'),
      cwd: __dirname,

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
      max_memory_restart: '700M', // restart if a leak pushes memory past this

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
  ],
};
