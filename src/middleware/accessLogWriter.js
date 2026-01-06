import path from 'node:path';
import fs from 'node:fs';
import { getRealIpFromHeader } from '../express-common.js';
import { BoundedCache, color, getConfigValue } from '../util.js';

const enableAccessLog = getConfigValue('logging.enableAccessLog', true, 'boolean');

// Track "known" IPs to only log the first request per IP in a time window.
// This must be bounded to prevent unbounded growth from scanners / DoS.
const knownIPs = new BoundedCache({
    ttlMs: getConfigValue('logging.knownIpsTtlMs', 24 * 60 * 60 * 1000, 'number'),
    maxEntries: getConfigValue('logging.knownIpsMaxEntries', 10_000, 'number'),
    sweepIntervalMs: 15 * 60 * 1000,
});

export const getAccessLogPath = () => path.join(globalThis.DATA_ROOT, 'access.log');

export function migrateAccessLog() {
    try {
        if (!fs.existsSync('access.log')) {
            return;
        }
        const logPath = getAccessLogPath();
        if (fs.existsSync(logPath)) {
            return;
        }
        fs.renameSync('access.log', logPath);
        console.log(color.yellow('Migrated access.log to new location:'), logPath);
    } catch (e) {
        console.error('Failed to migrate access log:', e);
        console.info('Please move access.log to the data directory manually.');
    }
}

/**
 * Creates middleware for logging access and new connections
 * @returns {import('express').RequestHandler}
 */
export default function accessLoggerMiddleware() {
    return function (req, res, next) {
        const clientIp = getRealIpFromHeader(req);
        const userAgent = req.headers['user-agent'];

        const isKnownIp = knownIPs.get(clientIp) !== null;
        // Refresh TTL/recency so the cache represents "seen recently".
        knownIPs.set(clientIp, Date.now());

        if (!isKnownIp) {
            // Log new connection
            // Write to access log if enabled
            if (enableAccessLog) {
                console.info(color.yellow(`New connection from ${clientIp}; User Agent: ${userAgent}\n`));
                const logPath = getAccessLogPath();
                const timestamp = new Date().toISOString();
                const log = `${timestamp} ${clientIp} ${userAgent}\n`;

                fs.appendFile(logPath, log, (err) => {
                    if (err) {
                        console.error('Failed to write access log:', err);
                    }
                });
            }
        }

        next();
    };
}
