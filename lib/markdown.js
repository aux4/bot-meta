// Markdown -> WhatsApp text formatting, plus the 4096-char message split
// WhatsApp's `/messages` endpoint requires. Used by the `format` and `send`
// plugin commands respectively.

/**
 * Converts common Markdown (as a brain command would produce) into
 * WhatsApp's own lightweight markup:
 *   **bold** / __bold__  -> *bold*
 *   *italic* / _italic_  -> _italic_
 *   ~~strike~~           -> ~strike~
 *   ```code```           -> ```code``` (unchanged, same fence syntax)
 *
 * Fenced code blocks are protected from every other substitution so code
 * contents are never reformatted.
 */
export function markdownToWhatsApp(markdown) {
  if (!markdown) return "";
  let text = String(markdown);

  const codeBlocks = [];
  text = text.replace(/```[\s\S]*?```/g, match => {
    codeBlocks.push(match);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // Bold first (consumes the double-marker forms), stashed behind a
  // placeholder so the italic pass below can't re-match its single markers.
  const boldBlocks = [];
  text = text.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
    boldBlocks.push(inner);
    return `\u0000BOLD${boldBlocks.length - 1}\u0000`;
  });
  text = text.replace(/__(.+?)__/g, (_, inner) => {
    boldBlocks.push(inner);
    return `\u0000BOLD${boldBlocks.length - 1}\u0000`;
  });

  // Remaining single-marker emphasis is italic in Markdown; WhatsApp's own
  // italic marker is an underscore.
  text = text.replace(/\*([^*\n]+)\*/g, "_$1_");
  text = text.replace(/_([^_\n]+)_/g, "_$1_");

  // Strikethrough.
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Restore bold as WhatsApp's single-asterisk bold.
  text = text.replace(/\u0000BOLD(\d+)\u0000/g, (_, i) => `*${boldBlocks[Number(i)]}*`);

  // Restore fenced code blocks verbatim.
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return text;
}

/**
 * Splits text into chunks no longer than `maxLen` (WhatsApp text messages
 * cap at 4096 chars), preferring to cut on a blank line, then a newline,
 * then a space, falling back to a hard cut only when no better boundary
 * exists within the limit.
 */
export function splitIntoChunks(text, maxLen = 4096) {
  const str = String(text == null ? "" : text);
  if (str.length <= maxLen) {
    return [str];
  }

  const chunks = [];
  let remaining = str;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}
