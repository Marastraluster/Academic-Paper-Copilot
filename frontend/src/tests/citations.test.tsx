/**
 * `[24]` in the reflowed prose, linked to the bibliography entry it names.
 *
 * Nothing is guessed: a number with no entry stays text, a marker that opens an
 * entry is the entry, and prose outside a reading with a bibliography is
 * rendered exactly as it was.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { IrParagraph, IrSection } from "@/api/ir";
import { MathText } from "@/bilingual/reflow/MathText";
import {
  buildReferenceIndex,
  CitationContext,
  splitCitations,
  type ReferenceEntry,
} from "@/bilingual/reflow/citations";

const section = (id: string, references = false) =>
  ({
    id, title: references ? "References" : "1 Introduction", level: 1, page_range: [1, 1],
    parent_id: null, heading_block_id: null, is_references: references,
  }) as IrSection;
const paragraph = (id: string, sectionId: string, text: string) =>
  ({ id, section_id: sectionId, text, page_number: 1, bboxes: [] }) as unknown as IrParagraph;

const SEPARATE = {
  sections: [section("s1"), section("refs", true)],
  paragraphs: [
    paragraph("p1", "s1", "Depth matters [2], see also [1, 3] and [7–9]."),
    paragraph("r1", "refs", "[1] Y. Bengio. Learning long-term dependencies. 1994."),
    paragraph("r2", "refs", "[2] K. Simonyan. Very deep networks. In ICLR, 2015."),
    paragraph("r3", "refs", "[3] C. Szegedy. Going deeper with convolutions, as in [1]. 2015."),
  ],
};

describe("the bibliography index", () => {
  it("reads one entry per numbered paragraph", () => {
    const index = buildReferenceIndex(SEPARATE);
    expect([...index.keys()]).toEqual([1, 2, 3]);
    expect(index.get(2)).toMatchObject({ paragraphId: "r2", text: expect.stringContaining("Very deep networks") });
  });

  it("cuts a bibliography the extractor ran together, at markers that count upwards", () => {
    const index = buildReferenceIndex({
      sections: [section("refs", true)],
      paragraphs: [paragraph("r", "refs",
        "[1] Y. Bengio. Long-term dependencies. 1994. [2] K. Simonyan. Very deep networks, cf. [1]. 2015. " +
        "[3] C. Szegedy. Going deeper. 2015.")],
    });
    expect([...index.keys()]).toEqual([1, 2, 3]);
    // The `[1]` cited inside entry 2 did not start a new entry.
    expect(index.get(2)!.text).toBe("[2] K. Simonyan. Very deep networks, cf. [1]. 2015.");
    expect(index.get(3)!.paragraphId).toBe("r");
  });

  it("is empty when the paper has no references section, or no reading", () => {
    expect(buildReferenceIndex({ sections: [section("s1")], paragraphs: SEPARATE.paragraphs }).size).toBe(0);
    expect(buildReferenceIndex(null).size).toBe(0);
  });
});

describe("citations in prose", () => {
  const index = buildReferenceIndex(SEPARATE);

  it("makes each cited number its own piece and keeps every character", () => {
    const text = "Depth matters [2], see also [1, 3] and [7–9].";
    const pieces = splitCitations(text, index);
    expect(pieces.map((piece) => piece.text).join("")).toBe(text);
    expect(pieces.filter((piece) => piece.kind === "number").map((piece) => piece.text)).toEqual(["2", "1", "3"]);
  });

  it("leaves alone what is not a citation of a known entry", () => {
    const untouched = ["[1] Y. Bengio. The entry itself.", "an interval [0, 1) and a set [x]", "see [42]", "[Fig. 2]"];
    for (const text of untouched) {
      expect(splitCitations(text, index)).toEqual([{ kind: "text", text }]);
    }
  });

  it("links a citation to its entry, with the entry as the tooltip", async () => {
    const user = userEvent.setup();
    const jump = vi.fn<(entry: ReferenceEntry) => void>();
    render(
      <CitationContext.Provider value={{ index, jump }}>
        <p><MathText text="Gates help $F(x)$ as shown in [2, 3]." cite /></p>
      </CitationContext.Provider>,
    );
    const links = screen.getAllByTestId("citation-link");
    expect(links.map((link) => link.textContent)).toEqual(["2", "3"]);
    expect(links[0]).toHaveAttribute("title", expect.stringContaining("Very deep networks"));
    await user.click(links[1]!);
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ number: 3, paragraphId: "r3" }));
  });

  it("renders plain text without a bibliography, and where linking is not asked for", () => {
    const { container, rerender } = render(<p><MathText text="As in [2]." cite /></p>);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("As in [2].");

    rerender(
      <CitationContext.Provider value={{ index, jump: vi.fn() }}>
        <p><MathText text="[2] K. Simonyan. Very deep networks, cf. [1]." /></p>
      </CitationContext.Provider>,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
