const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');

function createPNGBuffer(width, height) {
  const r = 59, g = 130, b = 246;
  const zlib = require('zlib');

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) {
      const cx = width / 2, cy = height / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const maxDist = Math.min(width, height) / 2;
      if (dist < maxDist) {
        raw.push(r, g, b, 255);
      } else {
        raw.push(0, 0, 0, 0);
      }
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function createICO(pngs) {
  const num = pngs.length;
  const header = Buffer.alloc(6 + 16 * num);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(num, 4);

  let offset = 6 + 16 * num;
  const chunks = [];

  pngs.forEach((png, i) => {
    const entry = header.slice(6 + 16 * i, 6 + 16 * (i + 1));
    const size = png.width >= 256 ? 0 : png.width;
    entry[0] = size;
    entry[1] = size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.data.length;
    chunks.push(png.data);
  });

  return Buffer.concat([header, ...chunks]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(w => ({ width: w, data: createPNGBuffer(w, w) }));

const ico = createICO(pngs);
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico);
console.log('✅ icon.ico 已生成 (包含 ' + sizes.length + ' 个尺寸)');

const icnsPng = createPNGBuffer(128, 128);
fs.writeFileSync(path.join(iconsDir, 'icon.icns'), icnsPng);
console.log('✅ icon.icns 占位文件已生成 (macOS 正式打包需用 iconutil 生成)');

console.log('');
console.log('📋 所有图标:');
sizes.forEach(s => console.log(`   - ${s}x${s} (PNG, in ICO)`));
console.log('   - icon.ico (Windows)');
console.log('   - icon.icns (macOS, 占位)');
console.log('');
console.log('✅ 图标生成完成，可以运行 tauri 了');
