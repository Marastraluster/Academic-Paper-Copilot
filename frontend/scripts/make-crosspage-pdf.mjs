/**
 * A PDF whose prose runs to the bottom of every page.
 *
 * The existing `make-fixture-pdf.mjs` puts five lines at the *top* of each page,
 * which is right for the viewer tests it was written for and useless here: a
 * cross-page selection starts on the last line of one page and ends on the first
 * line of the next, so the fixture has to actually reach both edges.
 *
 * Every line is prefixed `L<p>-<n>` so a harness can name the exact source line a
 * drag started and ended on, rather than asserting against "some paragraph".
 *
 * All three pages are A4 portrait and identically sized, deliberately. A
 * page-boundary drag crosses whatever page height the reader has; making the
 * pages differ would add a variable to a measurement that already has enough.
 *
 * Usage: node scripts/make-crosspage-pdf.mjs <output.pdf> [pages]
 */
import { writeFileSync } from "node:fs";

const FONT_SIZE = 11;
const LEADING = 14;
/** The extra gap that separates one paragraph from the next. */
const PARAGRAPH_GAP = 16;
const LINES_PER_PARAGRAPH = 4;
const TOP_MARGIN = 60;
const BOTTOM_MARGIN = 60;

/** A4 portrait, in points. */
const MEDIA_BOX = [0, 0, 595, 842];

/**
 * Filler that reads like a paper and contains no digits, so the only numeric
 * tokens in a selected line are its own `L<p>-<n>` marker and the harness cannot
 * match a fragment of prose by accident.
 */
const FILLER = [
  "we evaluate the learned policy across a suite of manipulation tasks and",
  "report the mean success rate together with the standard deviation over seeds",
  "the representation is trained jointly with the control policy in simulation",
  "each rollout collects observations actions and rewards under the current policy",
  "the resulting behaviour is compared against a strong model based baseline",
];

function lineFor(page, index) {
  return `L${page}-${String(index).padStart(2, "0")} ${FILLER[index % FILLER.length]}`;
}

/**
 * A page of lines, grouped into paragraphs with a visible gap between them.
 *
 * The gap is not cosmetic. With evenly-spaced lines the extractor reads a whole
 * page as **one** block, which would make every per-paragraph assertion in this
 * task vacuous — a "cross-page" selection would map to one paragraph per page
 * whose envelope is the entire page. The breaks are what make the geometry mean
 * something.
 */
function linesForPage(page) {
  const usable = MEDIA_BOX[3] - TOP_MARGIN - BOTTOM_MARGIN;
  const paragraphs = Math.floor(usable / (LINES_PER_PARAGRAPH * LEADING + PARAGRAPH_GAP));
  const lines = [];
  let y = MEDIA_BOX[3] - TOP_MARGIN;

  for (let group = 0; group < paragraphs; group += 1) {
    for (let inGroup = 0; inGroup < LINES_PER_PARAGRAPH; inGroup += 1) {
      lines.push({ text: lineFor(page, lines.length + 1), y });
      y -= LEADING;
    }
    y -= PARAGRAPH_GAP;
  }
  return lines;
}

function contentStream(lines) {
  return lines
    .map(
      (line) =>
        `BT /F1 ${FONT_SIZE} Tf 72 ${line.y} Td (${escapeText(line.text)}) Tj ET`,
    )
    .join("\n");
}

function escapeText(text) {
  return text.replace(/[\\()]/g, (match) => `\\${match}`);
}

function buildPdf(pageCount) {
  const objects = [];
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, i) => 3 + i * 2);
  const fontObjectNumber = 3 + pageCount * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] ` +
    `/Count ${pageCount} >>`;

  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = pageObjectNumbers[index];
    const streamNumber = pageNumber + 1;
    const stream = contentStream(linesForPage(index + 1));
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [${MEDIA_BOX.join(" ")}] ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${streamNumber} 0 R >>`;
    objects[streamNumber] = { stream };
  }

  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let number = 1; number < objects.length; number += 1) {
    const body = objects[number];
    if (body === undefined) continue;
    offsets[number] = Buffer.byteLength(pdf, "latin1");
    if (typeof body === "string") {
      pdf += `${number} 0 obj\n${body}\nendobj\n`;
    } else {
      const stream = Buffer.from(body.stream, "latin1");
      pdf += `${number} 0 obj\n<< /Length ${stream.length} >>\nstream\n`;
      pdf += stream.toString("latin1");
      pdf += "\nendstream\nendobj\n";
    }
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let number = 1; number < count; number += 1) {
    pdf += `${String(offsets[number] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const [target, pageArg] = process.argv.slice(2);
if (!target) {
  console.error("usage: node scripts/make-crosspage-pdf.mjs <output.pdf> [pages]");
  process.exit(1);
}

const pageCount = Number(pageArg ?? 3);
const bytes = buildPdf(pageCount);
writeFileSync(target, bytes);
const sample = linesForPage(1);
console.log(
  `wrote ${target} (${bytes.length} bytes, ${pageCount} pages, ` +
    `${sample.length} lines each in groups of ${LINES_PER_PARAGRAPH}: ` +
    `${sample[0].text.slice(0, 12)} … ${sample.at(-1).text.slice(0, 12)})`,
);
