#!/usr/bin/env node
// Scripted citation-checker for REQ/SPEC documents.
//
// REQ-WEBHOOK-001's own requirements-gate process (see docs/REQ-WEBHOOK-001-v1.md
// §9-§9e) spent 3 of its 6 review rounds finding nothing but wrong index.html:NNN
// citations — a wrong line number, a wrong function entirely cited under a
// plausible-sounding name, an approximate call-count that turned out imprecise.
// Every one of these was mechanically checkable: does the cited line exist, and
// what top-level function actually contains it. This script automates exactly
// that check so it happens in seconds, before a document goes to an independent
// review agent, instead of consuming a full review round to discover.
//
// This does NOT replace independent review. It cannot tell you whether a design
// is sound, whether an idempotency guard is correct, or whether a GDPR disclosure
// is complete — only a reviewer (agent or human) can do that. It only tells you,
// for every `index.html:NNN` or `index.html:NNN-MMM` citation in the document,
// whether the line exists and which top-level function it's actually inside —
// so a citation claiming "processImportRecords()" that resolves to a line inside
// pullAll() is caught before it wastes a review round.
//
// Usage:
//   node scripts/check-req-citations.js docs/REQ-WEBHOOK-001-v1.md
//   node scripts/check-req-citations.js docs/REQ-WEBHOOK-001-v1.md path/to/index.html

const fs = require('fs');
const path = require('path');

function main() {
  var docPath = process.argv[2];
  var srcPath = process.argv[3] || path.join(__dirname, '..', 'index.html');

  if (!docPath) {
    console.error('Usage: node scripts/check-req-citations.js <doc.md> [index.html]');
    process.exit(2);
  }
  if (!fs.existsSync(docPath)) {
    console.error('Doc not found: ' + docPath);
    process.exit(2);
  }
  if (!fs.existsSync(srcPath)) {
    console.error('Source file not found: ' + srcPath);
    process.exit(2);
  }

  var doc = fs.readFileSync(docPath, 'utf8');
  var src = fs.readFileSync(srcPath, 'utf8').split('\n'); // src[0] is line 1

  // Matches: index.html:1234  or  index.html:1234-1256  or  index.html:1234, 1256
  // Deliberately only matches citations against the file named on argv[3]/default
  // (basename match) so a doc citing multiple source files isn't misread.
  var srcBase = path.basename(srcPath);
  var re = new RegExp('\\b' + srcBase.replace(/\./g, '\\.') + ':(\\d+)(?:[-–](\\d+))?', 'g');

  var citations = [];
  var m;
  while ((m = re.exec(doc)) !== null) {
    var startLine = parseInt(m[1], 10);
    var endLine = m[2] ? parseInt(m[2], 10) : startLine;
    citations.push({ raw: m[0], start: startLine, end: endLine, docIndex: m.index });
  }

  if (citations.length === 0) {
    console.log('No ' + srcBase + ':NNN citations found in ' + docPath + '.');
    process.exit(0);
  }

  // Pre-index every top-level function's start line + name, in source order,
  // so "which function contains line N" is a simple last-one-before-N lookup.
  var fnStarts = []; // { line, name }
  var fnRe = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
  for (var i = 0; i < src.length; i++) {
    var mm = fnRe.exec(src[i]);
    if (mm) fnStarts.push({ line: i + 1, name: mm[1] });
  }

  function enclosingFn(lineNum) {
    var found = null;
    for (var i = 0; i < fnStarts.length; i++) {
      if (fnStarts[i].line <= lineNum) found = fnStarts[i];
      else break;
    }
    return found;
  }

  console.log('Checking ' + citations.length + ' citation(s) in ' + docPath + ' against ' + srcPath + '\n');

  var errors = 0;
  citations.forEach(function (c) {
    var lineExists = c.start >= 1 && c.end <= src.length;
    var lineContent = lineExists ? src[c.start - 1].trim() : null;
    var fn = lineExists ? enclosingFn(c.start) : null;

    // Rough context: the 60 chars of doc text right before the citation, so a
    // human/agent skimming output can eyeball whether the claimed function name
    // (if any appears nearby in prose) matches fn.name without re-opening the doc.
    var ctxStart = Math.max(0, c.docIndex - 80);
    var docContext = doc.slice(ctxStart, c.docIndex).replace(/\s+/g, ' ').trim();

    console.log('---');
    console.log('Citation: ' + c.raw);
    console.log('  Doc context before: ...' + docContext);
    if (!lineExists) {
      console.log('  ERROR: line ' + c.start + (c.end !== c.start ? '-' + c.end : '') + ' is out of range (source file has ' + src.length + ' lines)');
      errors++;
      return;
    }
    console.log('  Enclosing function: ' + (fn ? fn.name + ' (defined at line ' + fn.line + ')' : '(top-level / outside any function)'));
    console.log('  Line ' + c.start + ' content: ' + (lineContent.length > 140 ? lineContent.slice(0, 140) + '...' : lineContent));
    if (c.end !== c.start) {
      var lastLine = src[c.end - 1] ? src[c.end - 1].trim() : '';
      console.log('  Line ' + c.end + ' content: ' + (lastLine.length > 140 ? lastLine.slice(0, 140) + '...' : lastLine));
    }
  });

  console.log('\n---');
  console.log(citations.length + ' citation(s) checked, ' + errors + ' out-of-range error(s).');
  if (errors > 0) {
    console.log('FAIL: fix out-of-range citations before submitting for review.');
    process.exit(1);
  }
  console.log('All citations resolve to real lines. Manually eyeball each "Enclosing function" above against');
  console.log('what the surrounding prose actually claims it is — this script cannot check semantic meaning,');
  console.log('only that a citation is not pointing at the wrong or nonexistent place.');
  process.exit(0);
}

main();
