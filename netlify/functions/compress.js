const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  const inputPath = path.join(tmpDir, 'input.pdf');
  const outputPath = path.join(tmpDir, 'output.pdf');

  try {
    const body = JSON.parse(event.body);
    const { pdfBase64, targetBytes } = body;

    if (!pdfBase64 || !targetBytes) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing pdfBase64 or targetBytes' }) };
    }

    // Write input PDF
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    fs.writeFileSync(inputPath, pdfBuffer);

    const target = parseInt(targetBytes);
    const tolerance = 5 * 1024; // 5KB tolerance

    // Try Ghostscript with different quality settings
    // Binary search on Ghostscript dPDFSETTINGS and image resolution
    const gsSettings = [
      { dpi: 150, setting: '/screen' },
      { dpi: 120, setting: '/ebook' },
      { dpi: 100, setting: '/ebook' },
      { dpi: 85,  setting: '/screen' },
      { dpi: 72,  setting: '/screen' },
      { dpi: 60,  setting: '/screen' },
      { dpi: 50,  setting: '/screen' },
    ];

    let bestOutput = null;
    let bestDiff = Infinity;

    for (const cfg of gsSettings) {
      try {
        const tmpOut = path.join(tmpDir, `out_${cfg.dpi}.pdf`);
        const gsCmd = [
          'gs',
          '-sDEVICE=pdfwrite',
          '-dCompatibilityLevel=1.4',
          `-dPDFSETTINGS=${cfg.setting}`,
          '-dNOPAUSE',
          '-dQUIET',
          '-dBATCH',
          `-dDownsampleColorImages=true`,
          `-dColorImageResolution=${cfg.dpi}`,
          `-dDownsampleGrayImages=true`,
          `-dGrayImageResolution=${cfg.dpi}`,
          `-dDownsampleMonoImages=true`,
          `-dMonoImageResolution=${cfg.dpi}`,
          `-sOutputFile=${tmpOut}`,
          inputPath,
        ].join(' ');

        execSync(gsCmd, { timeout: 25000 });

        const stat = fs.statSync(tmpOut);
        const sz = stat.size;
        const diff = target - sz;

        if (diff >= 0) {
          // Under target — valid
          if (diff < bestDiff) {
            bestDiff = diff;
            bestOutput = tmpOut;
          }
          if (diff <= tolerance) break; // Good enough
        }
      } catch (e) {
        // gs not available or failed — try next
        console.log('gs attempt failed:', e.message);
      }
    }

    // If gs not available, fallback to pure pdf-lib via node
    if (!bestOutput) {
      // Ghostscript not available — return original with metadata stripped
      // Frontend will handle canvas compression
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          success: false,
          error: 'ghostscript_unavailable',
          message: 'Server compression not available, using client fallback',
        }),
      };
    }

    const outputBuffer = fs.readFileSync(bestOutput);
    const outputBase64 = outputBuffer.toString('base64');
    const finalSize = outputBuffer.length;

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        pdfBase64: outputBase64,
        originalSize: pdfBuffer.length,
        compressedSize: finalSize,
      }),
    };
  } catch (err) {
    console.error('Compress error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
};
