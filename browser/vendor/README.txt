Third-party code embedded into PDF-Tools.html (nothing is loaded from a CDN):

pdf.min.js, pdf.worker.min.js   pdf.js 3.11.174          Apache-2.0   https://github.com/mozilla/pdf.js
pdfjs-cmaps.json                pdf.js 3.11.174 CMaps    Apache-2.0   (CJK character maps, base64)
pdf-lib.min.js                  pdf-lib 1.17.1           MIT          https://github.com/Hopding/pdf-lib
fontkit.umd.min.js              @pdf-lib/fontkit 1.1.1   MIT          https://github.com/Hopding/fontkit
../fonts/Sarabun-*.ttf          Sarabun                  SIL OFL 1.1  https://github.com/cadsondemak/Sarabun

pdf.js is opened with isEvalSupported:false everywhere (mitigates CVE-2024-4367 in this old version).
