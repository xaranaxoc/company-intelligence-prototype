// Определение типа и размеров изображения по заголовкам файла (PNG/JPEG/GIF/WebP/SVG),
// без внешних зависимостей. Возвращает null, если формат не распознан.

export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
    return { type: 'jpeg', width: null, height: null };
  }
  // WebP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const fourcc = buf.subarray(12, 16).toString('ascii');
    if (fourcc === 'VP8X') {
      return {
        type: 'webp',
        width: 1 + (buf[24] | buf[25] << 8 | buf[26] << 16),
        height: 1 + (buf[27] | buf[28] << 8 | buf[29] << 16),
      };
    }
    if (fourcc === 'VP8 ') {
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return { type: 'webp', width: null, height: null };
  }
  // SVG
  const head = buf.subarray(0, 2048).toString('utf-8');
  if (head.includes('<svg')) {
    const vb = /viewBox=["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(head);
    const w = /width=["']([\d.]+)/.exec(head);
    const h = /height=["']([\d.]+)/.exec(head);
    return { type: 'svg', width: Number(w?.[1] ?? vb?.[1] ?? 0), height: Number(h?.[1] ?? vb?.[2] ?? 0) };
  }
  return null;
}

const EXT = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', svg: 'svg' };
export const extFor = (type) => EXT[type] || 'bin';
