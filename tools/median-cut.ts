// tools/median-cut.ts — reduce a set of colours to a palette.
//
// The Pocket3D title card (tools/pocket3d-title.ts) and the PS Vita app icon
// (tools/pocket3d-icon.ts) are stored with a palette of at most 256 colours.

export type Colour = { r: number; g: number; b: number; count: number };

/** Median cut over the distinct colours, weighted by how many pixels use each. */
export function medianCut(colours: Colour[], limit: number): Colour[][] {
  let boxes: Colour[][] = [colours];
  while (boxes.length < limit) {
    // split the box with the widest channel range that still holds two colours
    let pick = -1, widest = 0, channel: "r" | "g" | "b" = "r";
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (const c of ["r", "g", "b"] as const) {
        let low = 255, high = 0;
        for (const colour of box) { if (colour[c] < low) low = colour[c]; if (colour[c] > high) high = colour[c]; }
        // weight the range by the box's population so busy regions split first
        const weight = (high - low) * Math.log2(1 + box.reduce((sum, colour) => sum + colour.count, 0));
        if (weight > widest) { widest = weight; pick = index; channel = c; }
      }
    });
    if (pick < 0) break;
    const box = boxes[pick].slice().sort((a, b) => a[channel] - b[channel]);
    const half = box.reduce((sum, colour) => sum + colour.count, 0) / 2;
    let seen = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { seen += box[i].count; cut = i + 1; if (seen >= half) break; }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes;
}
