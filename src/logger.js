import fs from 'fs';
import path from 'path';
import os from 'os';

const APP_DIR = path.join(os.homedir(), '.termoslack');
if (!fs.existsSync(APP_DIR)) {
    try {
        fs.mkdirSync(APP_DIR, { recursive: true });
    } catch (err) {
        console.error('Failed to create app directory:', err);
    }
}

const LOG_FILE = path.join(APP_DIR, 'termoslack.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024;

let logStream = null;
let logDisabled = false;

function rotateIfOversized() {
    try {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > MAX_LOG_SIZE) {
            fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('Failed to rotate log file:', err);
        }
    }
}

function openLogStream() {
    try {
        const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
        stream.on('error', (err) => {
            logDisabled = true;
            logStream = null;
            console.error('Failed to write to log file:', err);
        });
        return stream;
    } catch (err) {
        logDisabled = true;
        console.error('Failed to open log file:', err);
        return null;
    }
}

rotateIfOversized();
logStream = openLogStream();

function formatTimestamp() {
    return new Date().toISOString();
}

function writeLog(level, message, error = null) {
    const timestamp = formatTimestamp();
    let logMessage = `[${timestamp}] [${level}] ${message}`;
    if (error) {
        logMessage += `\n  Error: ${error.message}`;
        if (error.stack) {
            logMessage += `\n  Stack: ${error.stack}`;
        }
    }
    logMessage += '\n';

    if (logDisabled || !logStream) return;

    try {
        logStream.write(logMessage);
    } catch (err) {
        logDisabled = true;
        console.error('Failed to write to log file:', err);
    }
}

function flushAndExit(code) {
    if (!logStream) {
        process.exit(code);
        return;
    }
    setTimeout(() => process.exit(code), 1000);
    logStream.end(() => process.exit(code));
}

export function logInfo(message) {
  writeLog('INFO', message);
}

export function logWarn(message) {
  writeLog('WARN', message);
}

export function logError(message, error = null) {
  writeLog('ERROR', message, error);
}

export function logFatal(message, error = null) {
  writeLog('FATAL', message, error);
}

process.on('uncaughtException', (error) => {
  logFatal('Uncaught exception', error);
  console.error('Fatal error:', error);
  flushAndExit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logFatal('Unhandled promise rejection', reason);
  console.error('Unhandled rejection:', reason);
});