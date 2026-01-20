// filepath: utils/attachments.js
// Utilities for handling Discord attachments

const SUPPORTED_MIME_TYPES = {
  'image/jpeg': true,
  'image/png': true,
  'image/gif': true,
  'image/webp': true,
  'audio/mp3': true,
  'audio/mpeg': true,
  'audio/wav': true,
  'audio/aac': true,
  'audio/ogg': true,
  'audio/flac': true,
  'video/mp4': true,
  'video/mpeg': true,
  'video/mov': true,
  'video/avi': true,
  'video/x-msvideo': true,
  'video/webm': true,
  'video/flv': true,
  'video/3gpp': true,
  'application/pdf': true,
  'text/plain': true,
  'text/html': true,
  'text/css': true,
  'text/javascript': true,
  'application/x-python': true,
  'text/x-python': true,
  'application/json': true,
  'text/markdown': true,
  'application/xml': true,
  'text/xml': true,
};

/**
 * Infer MIME type from filename
 * @param {string} filename - File name
 * @returns {string|null}
 */
function getMimeTypeFromName(filename) {
  if (!filename) return null;
  const lower = filename.toLowerCase();

  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.mpeg': 'video/mpeg',
    '.mov': 'video/mov', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.flv': 'video/flv',
    '.3gp': 'video/3gpp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.html': 'text/html',
    '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.py': 'text/x-python',
    '.json': 'application/json', '.md': 'text/markdown', '.xml': 'application/xml',
  };

  for (const [ext, mimeType] of Object.entries(mimeMap)) {
    if (lower.endsWith(ext)) return mimeType;
  }

  return null;
}

/**
 * Process and convert attachments to inline data for Gemini
 * @param {object[]} attachments - Array of Discord attachments
 * @returns {Promise<object[]>} Array of inline data objects or empty array
 */
async function processAttachments(attachments) {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const inlineDataList = [];

  for (const attachment of attachments) {
    let mimeType = attachment.contentType;
    if (!mimeType) {
      mimeType = getMimeTypeFromName(attachment.name);
    }

    // Convert GIF to MP4 for Gemini (GIF not supported, but video/mp4 is)
    if (mimeType === 'image/gif' || mimeType === 'image/apng') {
      mimeType = 'video/mp4';
    }

    if (!mimeType || !SUPPORTED_MIME_TYPES[mimeType]) {
      console.warn(`Skipping attachment "${attachment.name}" - unsupported MIME type: ${mimeType}`);
      continue;
    }

    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');

      inlineDataList.push({
        inlineData: {
          mimeType: mimeType,
          data: base64,
        },
      });
    } catch (e) {
      console.error(`Failed to fetch attachment ${attachment.name}:`, e);
    }
  }

  return inlineDataList;
}

module.exports = {
  processAttachments,
  getMimeTypeFromName,
  SUPPORTED_MIME_TYPES,
};
