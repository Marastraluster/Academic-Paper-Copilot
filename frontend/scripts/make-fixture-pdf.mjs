/**
 * Write a small multi-page PDF for the browser verification harness.
 *
 * Hand-built rather than pulled from a PDF library, because the harness only
 * needs a real, openable document with a text layer — and a committed fixture
 * binary would be opaque. Generating it keeps the input inspectable.
 *
 * Page sizes deliberately differ: page 2 is US Letter and page 3 is landscape,
 * so the harness exercises non-A4 geometry rather than assuming it.
 */
import { writeFileSync } from "node:fs";

const FONT_SIZE = 12;

function contentStream(lines, mediaBox) {
  // Anchor to the page's own height: a landscape page is only 595 tall, so a
  // portrait-shaped baseline would put the text off the page entirely.
  const pageHeight = mediaBox[3] - mediaBox[1];
  const top = pageHeight - 60;

  return lines
    .map(
      (line, index) =>
        `BT /F1 ${line.size ?? FONT_SIZE} Tf 72 ${top - index * 22} Td (${escapeText(line.text)}) Tj ET`,
    )
    .join("\n");
}

function escapeText(text) {
  // Only the characters this fixture uses; PDF strings are parenthesised, so
  // parentheses and backslashes must be escaped.
  return text.replace(/[\\()]/g, (match) => `\\${match}`);
}

const PAGES = [
  {
    mediaBox: [0, 0, 595, 842], // A4 portrait
    lines: [
      { text: "Learning Stable Policies for Robotic Manipulation", size: 16 },
      { text: "A. Author, B. Author - Institute of Robotics", size: 10 },
      { text: "Abstract", size: 13 },
      { text: "The policy is optimized through multiple rollouts collected from" },
      { text: "the simulator. We evaluate the learned policy on three benchmarks." },
    ],
  },
  {
    mediaBox: [0, 0, 612, 792], // US Letter portrait
    lines: [
      { text: "2. Method", size: 13 },
      { text: "Each rollout is a sequence of observations, actions and rewards" },
      { text: "gathered under the current policy, which is then updated." },
      { text: "Results indicate the proposed representation improves efficiency." },
    ],
  },
  {
    mediaBox: [0, 0, 842, 595], // A4 landscape
    lines: [
      { text: "3. Results", size: 13 },
      { text: "Table 1 reports the mean success rate across five seeds." },
      { text: "The learned policy outperforms the baseline in every setting." },
    ],
  },
];

/** Assemble the objects and compute byte offsets for a valid xref table. */
function buildPdf() {
  const objects = [];

  const pageObjectNumbers = PAGES.map((_, index) => 3 + index * 2);
  const fontObjectNumber = 3 + PAGES.length * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] ` +
    `/Count ${PAGES.length} >>`;

  PAGES.forEach((page, index) => {
    const pageNumber = pageObjectNumbers[index];
    const streamNumber = pageNumber + 1;
    const stream = contentStream(page.lines, page.mediaBox);

    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [${page.mediaBox.join(" ")}] ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${streamNumber} 0 R >>`;
    objects[streamNumber] = { stream };
  });

  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  // --- serialise, tracking offsets -----------------------------------------
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
  pdf += `xref\n0 ${count}\n`;
  pdf += "0000000000 65535 f \n";
  for (let number = 1; number < count; number += 1) {
    const offset = offsets[number] ?? 0;
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/make-fixture-pdf.mjs <output.pdf>");
  process.exit(1);
}

const bytes = buildPdf();
writeFileSync(target, bytes);
console.log(`wrote ${target} (${bytes.length} bytes, ${PAGES.length} pages)`);
