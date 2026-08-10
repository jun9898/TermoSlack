import terminalImage from "terminal-image";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { logInfo, logError } from "./logger.js";
import { getFileFetchHeaders } from "./user_client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.join(__dirname, "..", ".image-cache");

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logInfo(`Created image cache directory `);
}

function writeCacheAtomic(cachePath, buffer) {
    const tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, cachePath);
}

export async function getCachedImage(url, token, options = {}) {
    try{
        const hash = crypto.createHash("md5").update(url).digest("hex");
        const cachePath = path.join(CACHE_DIR, hash);

        if (fs.existsSync(cachePath)) {
            logInfo(`Loading image from cache: ${hash}`);
            const cachedBuffer = fs.readFileSync(cachePath);
            return await terminalImage.buffer(cachedBuffer,{
                width: options.width || '90%',
                height: options.height || '90%',
                preserveAspectRatio: true
            });
    }
    logInfo("Downloading image: " + url);
    const response = await fetch(url,{
        headers: getFileFetchHeaders(token)
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    if (!/^image\//.test(response.headers.get('content-type') || '')) {
        throw new Error('Slack returned a login page instead of the image (file download not authorized)');
    }
    const buffer = await response.buffer();

    writeCacheAtomic(cachePath, buffer);
    logInfo(`Cached image to: ${hash}`);

    return await terminalImage.buffer(buffer,{
        width: options.width || '90%',
        height: options.height || '90%',
        preserveAspectRatio: true
    });
    } catch (error) {
        logError("Error in getCachedImage:", error);
        return '[❌ Image failed - Terminal quality limited. Press O to open in browser]'
    }
}

export async function getImageBuffer(url, token) {
    try {
        const hash = crypto.createHash("md5").update(url).digest("hex");
        const cachePath = path.join(CACHE_DIR, hash);

        if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

        const response = await fetch(url, {
            headers: getFileFetchHeaders(token)
        });
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        if (!/^image\//.test(response.headers.get('content-type') || '')) {
            throw new Error('Slack returned a login page instead of the image (file download not authorized)');
        }
        const buffer = await response.buffer();

        writeCacheAtomic(cachePath, buffer);
        logInfo(`Cached image to: ${hash}`);
        return buffer;
    } catch (error) {
        logError("Error in getImageBuffer:", error);
        return null;
    }
}

export async function clearImageCache() {
    try{
        if (fs.existsSync(CACHE_DIR)) {
            const files = fs.readdirSync(CACHE_DIR);
            files.forEach(file => {
                fs.unlinkSync(path.join(CACHE_DIR, file));
            });
            logInfo("Cleared image cache");
        }
    } catch (error) {
        logError("Error clearing image cache:", error);
    }
}

export async function getSwatchColor(url, token) {
    try {
        const art = await getCachedImage(url, token, { width: 2, height: 1 });
        const match = /38;2;(\d+);(\d+);(\d+)/.exec(art) || /48;2;(\d+);(\d+);(\d+)/.exec(art);
        if (!match) return null;
        const hex = (n) => Number(n).toString(16).padStart(2, '0');
        return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
    } catch (error) {
        logError('Failed to compute swatch color', error);
        return null;
    }
}

export async function getImageThumbnail(url, token) {
    return await getCachedImage(url, token, {
        width: 20,
        height: 10
    });
}