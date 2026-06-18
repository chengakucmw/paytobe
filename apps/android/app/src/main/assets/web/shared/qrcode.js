/*!
 * VelarumPay QR generator (VPQR)
 * Self-contained, dependency-free QR Code encoder for offline use in the wallet WebView.
 * Byte mode (UTF-8), QR versions 1-40, ECC levels L/M/Q/H.
 * Algorithm ported from Project Nayuki's QR Code generator reference (MIT License).
 */
(function (root) {
  'use strict';

  // ---- Per-version error-correction tables (index 0 unused). Rows: L,M,Q,H ----
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
  ];
  // ecl ordinal (table row) and 2-bit format indicator
  var ECC = { L: { ord: 0, fb: 1 }, M: { ord: 1, fb: 0 }, Q: { ord: 2, fb: 3 }, H: { ord: 3, fb: 2 } };

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // ---- Reed-Solomon over GF(256), primitive poly 0x11d ----
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree; i++) result.push(0);
    result[degree - 1] = 1;
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, eclOrd) {
    return Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[eclOrd][ver] * NUM_ERROR_CORRECTION_BLOCKS[eclOrd][ver];
  }

  // ---- Build the data bit list (byte mode) ----
  function toUtf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }

  function QrCode(version, eclName, dataCodewords, mask) {
    this.version = version;
    this.ecl = eclName;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    var row;
    for (var i = 0; i < this.size; i++) {
      row = [];
      for (var j = 0; j < this.size; j++) row.push(false);
      this.modules.push(row.slice());
      this.isFunction.push(row.slice());
    }
    this.drawFunctionPatterns();
    var allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);
    if (mask < 0) {
      var minPenalty = Infinity;
      for (var m = 0; m < 8; m++) {
        this.applyMask(m);
        this.drawFormatBits(m);
        var penalty = this.getPenaltyScore();
        if (penalty < minPenalty) { mask = m; minPenalty = penalty; }
        this.applyMask(m); // undo
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  QrCode.prototype.setFunc = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.drawFunctionPatterns = function () {
    var size = this.size, i;
    for (i = 0; i < size; i++) {
      this.setFunc(6, i, i % 2 === 0);
      this.setFunc(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    var pos = this.alignPositions();
    var n = pos.length;
    for (i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlign(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };

  QrCode.prototype.drawFinder = function (cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunc(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };

  QrCode.prototype.drawAlign = function (cx, cy) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        this.setFunc(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };

  QrCode.prototype.alignPositions = function () {
    if (this.version === 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = (this.version === 32) ? 26 :
      Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var p = this.size - 7; result.length < numAlign; p -= step) result.splice(1, 0, p);
    return result;
  };

  QrCode.prototype.drawFormatBits = function (mask) {
    var fb = ECC[this.ecl].fb;
    var data = (fb << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var size = this.size, k;
    for (k = 0; k <= 5; k++) this.setFunc(8, k, getBit(bits, k));
    this.setFunc(8, 7, getBit(bits, 6));
    this.setFunc(8, 8, getBit(bits, 7));
    this.setFunc(7, 8, getBit(bits, 8));
    for (k = 9; k < 15; k++) this.setFunc(14 - k, 8, getBit(bits, k));
    for (k = 0; k < 8; k++) this.setFunc(size - 1 - k, 8, getBit(bits, k));
    for (k = 8; k < 15; k++) this.setFunc(8, size - 15 + k, getBit(bits, k));
    this.setFunc(8, size - 8, true);
  };

  QrCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (this.version << 12) | rem;
    for (var k = 0; k < 18; k++) {
      var bit = getBit(bits, k);
      var a = this.size - 11 + (k % 3);
      var b = Math.floor(k / 3);
      this.setFunc(a, b, bit);
      this.setFunc(b, a, bit);
    }
  };

  QrCode.prototype.addEccAndInterleave = function (data) {
    var ver = this.version, eclOrd = ECC[this.ecl].ord;
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclOrd][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[eclOrd][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    var divisor = rsDivisor(blockEccLen);
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var idx = 0; idx < blocks[0].length; idx++) {
      for (var b = 0; b < blocks.length; b++) {
        if (idx !== shortBlockLen - blockEccLen || b >= numShortBlocks)
          result.push(blocks[b][idx]);
      }
    }
    return result;
  };

  QrCode.prototype.drawCodewords = function (data) {
    var size = this.size, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  QrCode.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function () {
    var size = this.size, result = 0, x, y, i;
    // Rows
    for (y = 0; y < size; y++) {
      var runColor = false, runX = 0, runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
          runColor = this.modules[y][x]; runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
    }
    // Columns
    for (x = 0; x < size; x++) {
      var rc = false, ry = 0, rh = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y++) {
        if (this.modules[y][x] === rc) {
          ry++;
          if (ry === 5) result += 3;
          else if (ry > 5) result++;
        } else {
          this.finderPenaltyAddHistory(ry, rh);
          if (!rc) result += this.finderPenaltyCountPatterns(rh) * 40;
          rc = this.modules[y][x]; ry = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(rc, ry, rh) * 40;
    }
    // 2x2 blocks
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1])
          result += 3;
      }
    }
    // Dark proportion
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    var total = size * size;
    var k = 0;
    while (dark * 20 < (9 - k) * total || dark * 20 > (11 + k) * total) k++;
    result += k * 10;
    return result;
  };

  QrCode.prototype.finderPenaltyCountPatterns = function (rh) {
    var n = rh[1];
    var core = n > 0 && rh[2] === n && rh[3] === n * 3 && rh[4] === n && rh[5] === n;
    return (core && rh[0] >= n * 4 && rh[6] >= n ? 1 : 0) +
      (core && rh[6] >= n * 4 && rh[0] >= n ? 1 : 0);
  };
  QrCode.prototype.finderPenaltyTerminateAndCount = function (curColor, curRun, rh) {
    if (curColor) { this.finderPenaltyAddHistory(curRun, rh); curRun = 0; }
    curRun += this.size;
    this.finderPenaltyAddHistory(curRun, rh);
    return this.finderPenaltyCountPatterns(rh);
  };
  QrCode.prototype.finderPenaltyAddHistory = function (curRun, rh) {
    if (rh[0] === 0) curRun += this.size;
    rh.pop();
    rh.unshift(curRun);
  };

  // ---- Public encode: pick smallest fitting version ----
  function encode(text, opts) {
    opts = opts || {};
    var eclName = (opts.ecl || 'M').toUpperCase();
    if (!ECC[eclName]) eclName = 'M';
    var minV = opts.minVersion || 1, maxV = opts.maxVersion || 40;
    var bytes = toUtf8Bytes(String(text));
    var version = -1, dataUsedBits = 0, dataCapacityBits = 0;
    for (var v = minV; v <= maxV; v++) {
      var capBits = getNumDataCodewords(v, ECC[eclName].ord) * 8;
      var ccBits = v <= 9 ? 8 : 16;
      var usedBits = 4 + ccBits + 8 * bytes.length;
      if (usedBits <= capBits) { version = v; dataUsedBits = usedBits; dataCapacityBits = capBits; break; }
    }
    if (version < 0) throw new Error('Data too long for QR code');

    // Build bit buffer
    var bb = [];
    function appendBits(val, len) { for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }
    appendBits(0x4, 4); // byte mode
    appendBits(bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach(function (b) { appendBits(b, 8); });
    // Terminator + bit/byte padding
    appendBits(0, Math.min(4, dataCapacityBits - bb.length));
    appendBits(0, (8 - bb.length % 8) % 8);
    for (var pad = 0xEC; bb.length < dataCapacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);
    // Pack into codeword bytes
    var dataCodewords = [];
    for (var i = 0; i < bb.length; i += 8) {
      var byteVal = 0;
      for (var j = 0; j < 8; j++) byteVal = (byteVal << 1) | bb[i + j];
      dataCodewords.push(byteVal);
    }
    var qr = new QrCode(version, eclName, dataCodewords, opts.mask == null ? -1 : opts.mask);
    return { size: qr.size, version: qr.version, mask: qr.mask, modules: qr.modules };
  }

  // ---- SVG render into a DOM element (browser only) ----
  function toSvg(text, opts) {
    opts = opts || {};
    var qr = encode(text, opts);
    var margin = opts.margin == null ? 4 : opts.margin;
    var dim = qr.size + margin * 2;
    var dark = opts.dark || '#0b1f17';
    var light = opts.light || '#ffffff';
    var parts = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) parts.push('M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" role="img" aria-label="Wallet address QR code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + parts.join('') + '" fill="' + dark + '"/></svg>';
  }

  function render(el, text, opts) {
    if (!el) return false;
    if (!text) { el.innerHTML = ''; return false; }
    try {
      el.innerHTML = toSvg(text, opts);
      el.setAttribute('data-qr-rendered', '1');
      return true;
    } catch (e) {
      el.innerHTML = '';
      return false;
    }
  }

  var api = { encode: encode, toSvg: toSvg, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VPQR = api;
})(typeof window !== 'undefined' ? window : this);
