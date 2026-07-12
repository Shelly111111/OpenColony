const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'src-tauri', 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

function createPNG(width, height, r, g, b) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

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

  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type);
    const crcData = Buffer.concat([typeBuffer, data]);
    const crcValue = crc32(crcData);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crcValue, 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0);
    for (let x = 0; x < width; x++) {
      const cx = width / 2;
      const cy = height / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const maxDist = Math.min(width, height) / 2;
      if (dist < maxDist) {
        rawData.push(r, g, b);
      } else {
        rawData.push(255, 255, 255);
      }
    }
  }

  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(rawData));

  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const icon32 = createPNG(32, 32, 59, 130, 246);
const icon128 = createPNG(128, 128, 59, 130, 246);
const icon256 = createPNG(256, 256, 59, 130, 246);

fs.writeFileSync(path.join(iconsDir, '32x32.png'), icon32);
fs.writeFileSync(path.join(iconsDir, '128x128.png'), icon128);
fs.writeFileSync(path.join(iconsDir, '128x128@2x.png'), icon256);

console.log('✅ PNG 图标已生成:');
console.log('   - 32x32.png');
console.log('   - 128x128.png');
console.log('   - 128x128@2x.png');
console.log('');
console.log('⚠️  注意: Windows .ico 和 macOS .icns 图标需要额外工具生成');
console.log('   开发阶段可临时使用 PNG 图标，或使用以下工具:');
console.log('   - Windows: https://icoconvert.com/ 生成 .ico');
console.log('   - macOS: iconutil 生成 .icns');
console.log('');
console.log('或者安装后运行: npm run tauri icon icon.png');
