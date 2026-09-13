"""Optional regeneration of committed contour JSON from the credited SVGs.
Requires svgpathtools 1.8.0; Blender itself needs only the generated JSON.
"""
import json
from pathlib import Path
from svgpathtools import svg2paths2

for source in Path(__file__).parent.glob('*.svg'):
    paths, _, _ = svg2paths2(str(source))
    contours = []
    for path in paths:
        for subpath in path.continuous_subpaths():
            points = []
            for segment in subpath:
                count = 1 if type(segment).__name__ == 'Line' else 12
                points.extend([[round(segment.point(i/count).real,4),
                                round(segment.point(i/count).imag,4)] for i in range(count)])
            contours.append(points)
    xs = [p[0] for contour in contours for p in contour]
    ys = [p[1] for contour in contours for p in contour]
    source.with_suffix('.json').write_text(json.dumps({
        'source': source.name, 'bounds': [min(xs),min(ys),max(xs),max(ys)],
        'contours': contours,
    }, separators=(',', ':'))+'\n')
