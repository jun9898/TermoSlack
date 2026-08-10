import { getImageBuffer } from './image_cache.js';
import { logInfo, logError } from './logger.js';

const PLACEHOLDER = String.fromCodePoint(0x10EEEE);

const ROWCOLUMN_DIACRITICS = (
  "0305 030d 030e 0310 0312 033d 033e 033f 0346 034a 034b 034c 0350 0351 0352 0357 " +
  "035b 0363 0364 0365 0366 0367 0368 0369 036a 036b 036c 036d 036e 036f 0483 0484 " +
  "0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059c 059d 059e 059f 05a0 05a1 " +
  "05a8 05a9 05ab 05ac 05af 05c4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658 " +
  "0659 065a 065b 065d 065e 06d6 06d7 06d8 06d9 06da 06db 06dc 06df 06e0 06e1 06e2 " +
  "06e4 06e7 06e8 06eb 06ec 0730 0732 0733 0735 0736 073a 073d 073f 0740 0741 0743 " +
  "0745 0747 0749 074a 07eb 07ec 07ed 07ee 07ef 07f0 07f1 07f3 0816 0817 0818 0819 " +
  "081b 081c 081d 081e 081f 0820 0821 0822 0823 0825 0826 0827 0829 082a 082b 082c " +
  "082d 0951 0953 0954 0f82 0f83 0f86 0f87 135d 135e 135f 17dd 193a 1a17 1a75 1a76 " +
  "1a77 1a78 1a79 1a7a 1a7b 1a7c 1b6b 1b6d 1b6e 1b6f 1b70 1b71 1b72 1b73 1cd0 1cd1 " +
  "1cd2 1cda 1cdb 1ce0 1dc0 1dc1 1dc3 1dc4 1dc5 1dc6 1dc7 1dc8 1dc9 1dcb 1dcc 1dd1 " +
  "1dd2 1dd3 1dd4 1dd5 1dd6 1dd7 1dd8 1dd9 1dda 1ddb 1ddc 1ddd 1dde 1ddf 1de0 1de1 " +
  "1de2 1de3 1de4 1de5 1de6 1dfe 20d0 20d1 20d4 20d5 20d6 20d7 20db 20dc 20e1 20e7 " +
  "20e9 20f0 2cef 2cf0 2cf1 2de0 2de1 2de2 2de3 2de4 2de5 2de6 2de7 2de8 2de9 2dea " +
  "2deb 2dec 2ded 2dee 2def 2df0 2df1 2df2 2df3 2df4 2df5 2df6 2df7 2df8 2df9 2dfa " +
  "2dfb 2dfc 2dfd 2dfe 2dff a66f a67c a67d a6f0 a6f1 a8e0 a8e1 a8e2 a8e3 a8e4 a8e5 " +
  "a8e6 a8e7 a8e8 a8e9 a8ea a8eb a8ec a8ed a8ee a8ef a8f0 a8f1 aab0 aab2 aab3 aab7 " +
  "aab8 aabe aabf aac1 fe20 fe21 fe22 fe23 fe24 fe25 fe26 10a0f 10a38 1d185 1d186 1d187 " +
  "1d188 1d189 1d1aa 1d1ab 1d1ac 1d1ad 1d242 1d243 1d244"
).split(" ").map((h) => String.fromCodePoint(parseInt(h, 16)));

const EMOJI_COLS = 2;
const EMOJI_ROWS = 1;
const CHUNK_SIZE = 4096;

const MIN_IMAGE_ID = 16;
const MAX_IMAGE_ID = 254;
const VIEWER_IMAGE_ID = 255;
const MAX_GRID_SPAN = ROWCOLUMN_DIACRITICS.length;
const CELL_ASPECT = 2;
const MAX_CONCURRENT_FETCH = 4;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let enabled = false;
let program = null;
let tokenProvider = null;
let repaintHandler = null;

const ready = new Map();
const failed = new Set();
const queued = new Set();
const usageOrder = [];
let fetchQueue = [];
let fetchActive = 0;
let readyBatch = 0;
let viewerActive = false;
let tmuxWrap = false;

function isInsideTmux(env) {
  return !!env.TMUX || env.TERM_PROGRAM === 'tmux' || /^(screen|tmux)([.-]|$)/.test(env.TERM || '');
}

function outerTerminalSupported(env) {
  if (env.KITTY_WINDOW_ID) return true;
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return true;
  if (env.TERM_PROGRAM === 'ghostty') return true;
  return /kitty|ghostty/i.test(env.TERM || '');
}

export function detectKittyGraphics(env = process.env) {
  const override = env.TERMOSLACK_KITTY;
  if (override === '0' || override === 'false') return false;
  if (override === '1' || override === 'true') return true;

  return outerTerminalSupported(env);
}

export function needsTmuxPassthrough(env = process.env) {
  return isInsideTmux(env);
}

export function initKittyGraphics(screen, getToken) {
  enabled = false;
  program = null;
  tokenProvider = null;

  try {
    if (!detectKittyGraphics()) return false;
    if (!screen?.program?.output?.writable) return false;
    const colors = screen.program.tput?.colors ?? 0;
    if (colors < 256) {
      logInfo(`Kitty graphics disabled: terminal reports ${colors} colors`);
      return false;
    }
    program = screen.program;
    tokenProvider = getToken;
    tmuxWrap = needsTmuxPassthrough();
    enabled = true;
    logInfo(`Kitty inline emoji enabled (TERM=${process.env.TERM}${tmuxWrap ? ', tmux passthrough' : ''})`);
    return true;
  } catch (error) {
    logError('Kitty graphics init failed', error);
    return false;
  }
}

export function isKittyGraphicsEnabled() {
  return enabled;
}

export function setKittyRepaintHandler(fn) {
  repaintHandler = fn;
}

export function buildPlaceholder(imageId, cols = EMOJI_COLS, rows = EMOJI_ROWS) {
  let out = `\x1b[38;5;${imageId}m`;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out += PLACEHOLDER + ROWCOLUMN_DIACRITICS[row] + ROWCOLUMN_DIACRITICS[col];
    }
  }
  return out + '\x1b[39m';
}

export function buildTransmitSequences(imageId, base64, cols = EMOJI_COLS, rows = EMOJI_ROWS) {
  const chunks = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) chunks.push(base64.slice(i, i + CHUNK_SIZE));
  if (chunks.length === 0) chunks.push('');

  return chunks.map((chunk, index) => {
    const more = index < chunks.length - 1 ? 1 : 0;
    const keys = index === 0
      ? `a=T,U=1,i=${imageId},f=100,t=d,c=${cols},r=${rows},q=2,m=${more}`
      : `m=${more}`;
    return `\x1b_G${keys};${chunk}\x1b\\`;
  });
}

export function buildDeleteSequence(imageId) {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2;\x1b\\`;
}

export function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export function fitToCells(pixelWidth, pixelHeight, maxCols, maxRows) {
  const limitCols = Math.max(1, Math.min(maxCols, MAX_GRID_SPAN));
  const limitRows = Math.max(1, Math.min(maxRows, MAX_GRID_SPAN));

  let cols = limitCols;
  let rows = Math.round((pixelHeight / pixelWidth) * cols / CELL_ASPECT);
  if (rows > limitRows) {
    rows = limitRows;
    cols = Math.round((pixelWidth / pixelHeight) * rows * CELL_ASPECT);
  }
  return {
    cols: Math.max(1, Math.min(cols, limitCols)),
    rows: Math.max(1, Math.min(rows, limitRows))
  };
}

export function kittyPlaceholderCell(row, col) {
  return PLACEHOLDER + ROWCOLUMN_DIACRITICS[row] + ROWCOLUMN_DIACRITICS[col];
}

export function prepareKittyViewerImage(buffer, boxCols, boxRows) {
  if (!enabled || !buffer) return null;
  try {
    const size = readPngSize(buffer);
    if (!size) return null;

    const { cols, rows } = fitToCells(size.width, size.height, boxCols, boxRows);

    write(buildDeleteSequence(VIEWER_IMAGE_ID));
    const sequences = buildTransmitSequences(VIEWER_IMAGE_ID, buffer.toString('base64'), cols, rows);
    for (const sequence of sequences) {
      if (!write(sequence)) return null;
    }

    viewerActive = true;
    return { imageId: VIEWER_IMAGE_ID, cols, rows };
  } catch (error) {
    logError('Kitty viewer render failed', error);
    return null;
  }
}

export function clearKittyViewerImage() {
  if (!viewerActive) return;
  viewerActive = false;
  if (!enabled) return;
  write(buildDeleteSequence(VIEWER_IMAGE_ID));
}

export function kittyEmojiToken(name, url) {
  if (!enabled || failed.has(name)) return null;

  const entry = ready.get(name);
  if (entry) {
    touch(name);
    return entry.placeholder;
  }

  if (!queued.has(name)) {
    queued.add(name);
    fetchQueue.push({ name, url });
    drainFetchQueue();
  }
  return null;
}

function touch(name) {
  const at = usageOrder.indexOf(name);
  if (at !== -1) usageOrder.splice(at, 1);
  usageOrder.push(name);
}

function allocateImageId() {
  const used = new Set();
  for (const entry of ready.values()) used.add(entry.id);
  for (let id = MIN_IMAGE_ID; id <= MAX_IMAGE_ID; id++) {
    if (!used.has(id)) return id;
  }

  const victim = usageOrder.shift();
  if (victim === undefined) return null;
  const entry = ready.get(victim);
  ready.delete(victim);
  if (entry) {
    write(buildDeleteSequence(entry.id));
    return entry.id;
  }
  return null;
}

function write(sequence) {
  try {
    if (tmuxWrap) {
      program._write(`\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`);
    } else {
      program._write(sequence);
    }
    return true;
  } catch (error) {
    logError('Kitty graphics write failed', error);
    return false;
  }
}

function transmit(name, buffer) {
  if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    failed.add(name);
    return false;
  }

  const imageId = allocateImageId();
  if (imageId === null) {
    failed.add(name);
    return false;
  }

  const sequences = buildTransmitSequences(imageId, buffer.toString('base64'));
  for (const sequence of sequences) {
    if (!write(sequence)) {
      failed.add(name);
      return false;
    }
  }

  ready.set(name, { id: imageId, placeholder: buildPlaceholder(imageId) });
  touch(name);
  return true;
}

function drainFetchQueue() {
  while (fetchActive < MAX_CONCURRENT_FETCH && fetchQueue.length > 0) {
    const job = fetchQueue.shift();
    fetchActive++;
    getImageBuffer(job.url, tokenProvider ? tokenProvider() : undefined)
      .then((buffer) => {
        if (!buffer) {
          failed.add(job.name);
          return;
        }
        if (transmit(job.name, buffer)) readyBatch++;
      })
      .catch((error) => {
        logError(`Kitty emoji transmit failed: ${job.name}`, error);
        failed.add(job.name);
      })
      .finally(() => {
        fetchActive--;
        queued.delete(job.name);
        if (fetchQueue.length > 0) {
          drainFetchQueue();
          return;
        }
        if (fetchActive === 0 && readyBatch > 0) {
          readyBatch = 0;
          if (repaintHandler) {
            try { repaintHandler(); } catch (error) { logError('Kitty repaint handler failed', error); }
          }
        }
      });
  }
}

export function resetKittyGraphicsForTest() {
  enabled = false;
  program = null;
  tokenProvider = null;
  repaintHandler = null;
  ready.clear();
  failed.clear();
  queued.clear();
  usageOrder.length = 0;
  fetchQueue = [];
  fetchActive = 0;
  readyBatch = 0;
  viewerActive = false;
}
