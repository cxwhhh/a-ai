"""Original teaching prototype. Run: python build.py --seed; python build.py.
--seed overwrites SVG masters; ordinary builds preserve edits.
"""
from pathlib import Path
import argparse, json, xml.etree.ElementTree as ET
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
SVG = ROOT / 'svg'
OUT = ROOT / 'dist'
# Skeleton coordinates: baseline 0, cap centre 650, visible caps -42..692.
# All skeletons are authored here, without tracing or importing another font.
S = {
'A': [[(0,0),(225,650),(450,0)],[(85,230),(365,230)]],
'B': [[(0,0),(0,650),(300,650),(420,550),(420,440),(310,330),(0,330)],[(310,330),(440,220),(440,100),(320,0),(0,0)]],
'C': [[(450,550),(350,650),(100,650),(0,550),(0,100),(100,0),(350,0),(450,100)]],
'D': [[(0,0),(0,650),(300,650),(450,500),(450,150),(300,0),(0,0)]],
'E': [[(440,650),(0,650),(0,0),(440,0)],[(0,330),(350,330)]],
'F': [[(0,0),(0,650),(440,650)],[(0,330),(350,330)]],
'G': [[(450,550),(350,650),(100,650),(0,550),(0,100),(100,0),(350,0),(450,100),(450,290),(270,290)]],
'H': [[(0,0),(0,650)],[(450,0),(450,650)],[(0,325),(450,325)]],
'I': [[(0,650),(220,650)],[(110,650),(110,0)],[(0,0),(220,0)]],
'J': [[(100,650),(450,650),(450,110),(340,0),(110,0),(0,110)]],
'K': [[(0,0),(0,650)],[(450,650),(0,270)],[(180,420),(450,0)]],
'L': [[(0,650),(0,0),(420,0)]],
'M': [[(0,0),(0,650),(280,260),(560,650),(560,0)]],
'N': [[(0,0),(0,650),(450,0),(450,650)]],
'O': [[(100,0),(0,100),(0,550),(100,650),(350,650),(450,550),(450,100),(350,0),(100,0)]],
'P': [[(0,0),(0,650),(310,650),(440,530),(440,420),(310,300),(0,300)]],
'Q': [[(100,0),(0,100),(0,550),(100,650),(350,650),(450,550),(450,100),(350,0),(100,0)],[(280,170),(500,-80)]],
'R': [[(0,0),(0,650),(310,650),(440,530),(440,420),(310,300),(0,300)],[(250,300),(460,0)]],
'S': [[(440,550),(340,650),(100,650),(0,550),(0,425),(100,325),(340,325),(440,225),(440,100),(340,0),(100,0),(0,100)]],
'T': [[(0,650),(480,650)],[(240,650),(240,0)]],
'U': [[(0,650),(0,110),(110,0),(340,0),(450,110),(450,650)]],
'V': [[(0,650),(225,0),(450,650)]],
'W': [[(0,650),(130,0),(280,360),(430,0),(560,650)]],
'X': [[(0,650),(450,0)],[(450,650),(0,0)]],
'Y': [[(0,650),(225,320),(450,650)],[(225,320),(225,0)]],
'Z': [[(0,650),(450,650),(0,0),(450,0)]],
'0': [[(100,0),(0,100),(0,550),(100,650),(350,650),(450,550),(450,100),(350,0),(100,0)],[(120,160),(330,490)]],
'1': [[(80,500),(230,650),(230,0)],[(70,0),(390,0)]],
'2': [[(0,540),(110,650),(340,650),(450,540),(450,430),(0,0),(450,0)]],
'3': [[(0,550),(100,650),(340,650),(450,540),(450,440),(340,325),(190,325)],[(340,325),(450,210),(450,110),(340,0),(100,0),(0,100)]],
'4': [[(340,0),(340,650),(0,210),(450,210)]],
'5': [[(450,650),(0,650),(0,330),(330,330),(450,210),(450,110),(340,0),(100,0),(0,100)]],
'6': [[(440,550),(340,650),(110,650),(0,540),(0,110),(110,0),(340,0),(450,110),(450,220),(340,330),(0,330)]],
'7': [[(0,650),(450,650),(100,0)]],
'8': [[(110,325),(0,435),(0,540),(110,650),(340,650),(450,540),(450,435),(340,325),(110,325),(0,215),(0,110),(110,0),(340,0),(450,110),(450,215),(340,325)]],
'9': [[(450,320),(110,320),(0,430),(0,540),(110,650),(340,650),(450,540),(450,110),(340,0),(100,0),(0,100)]],
'.': [[(0,0),(0,8)]], ',': [[(45,8),(0,-100)]],
':': [[(0,110),(0,118)],[(0,430),(0,438)]],
';': [[(45,110),(0,0)],[(45,430),(45,438)]],
'!': [[(0,650),(0,210)],[(0,0),(0,8)]],
'?': [[(0,540),(110,650),(330,650),(440,540),(440,430),(220,260),(220,190)],[(220,0),(220,8)]],
'-': [[(0,300),(260,300)]], '+': [[(0,300),(360,300)],[(180,120),(180,480)]],
'=': [[(0,200),(360,200)],[(0,400),(360,400)]],
'/': [[(0,-40),(360,690)]],
'(': [[(170,700),(0,530),(0,120),(170,-50)]],
')': [[(0,700),(170,530),(170,120),(0,-50)]],
}

def seed():
    from shapely.geometry import LineString
    from shapely.ops import unary_union
    from shapely.geometry.polygon import orient
    SVG.mkdir(exist_ok=True)
    for char, strokes in S.items():
        shape = unary_union([LineString(s).buffer(42, cap_style=2, join_style=3) for s in strokes])
        minx, _, maxx, _ = shape.bounds
        shift = 64-minx
        advance = round(maxx-minx+128)
        pieces = list(shape.geoms) if shape.geom_type == 'MultiPolygon' else [shape]
        paths = []
        for piece in pieces:
            # Clockwise outer contours in font coordinates, opposite counters.
            piece = orient(piece, sign=-1)
            for ring in [piece.exterior, *piece.interiors]:
                pts = [(round(x+shift), round(800-y)) for x,y in list(ring.coords)[:-1]]
                paths.append('M'+' L'.join(f'{x} {y}' for x,y in pts)+' Z')
        (SVG / f'U{ord(char):04X}.svg').write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {advance} 1000" data-advance="{advance}">\n'
            f'  <path fill="black" d="{" ".join(paths)}"/>\n</svg>\n', encoding='utf-8')

def name(c): return 'space' if c == ' ' else f'uni{ord(c):04X}'

def draw(paths, pen):
    flipped = TransformPen(pen, (1,0,0,-1,0,800))
    for d in paths: parse_path(d, flipped)

def build():
    OUT.mkdir(exist_ok=True)
    sources = {}
    for p in sorted(SVG.glob('U*.svg')):
        root = ET.parse(p).getroot()
        sources[chr(int(p.stem[1:],16))] = (int(root.attrib['data-advance']),
            [el.attrib['d'] for el in root.iter() if el.tag.endswith('path')])
    sources[' '] = (320, [])
    order = ['.notdef'] + [name(c) for c in sources]
    records = {name(c): v for c,v in sources.items()}
    records['.notdef'] = (600,['M64 800 L64 100 L536 100 L536 800 Z M148 716 L452 716 L452 184 L148 184 Z'])
    for ttf in (True,False):
        fb = FontBuilder(1000,isTTF=ttf)
        fb.setupGlyphOrder(order)
        fb.setupCharacterMap({ord(c):name(c) for c in sources})
        glyphs = {}
        metrics = {}
        for gn,(width,paths) in records.items():
            pen = TTGlyphPen(None) if ttf else T2CharStringPen(width,None)
            if ttf:
                from fontTools.pens.cu2quPen import Cu2QuPen
                draw(paths,Cu2QuPen(pen,1.0,reverse_direction=False))
            else: draw(paths,pen)
            glyphs[gn] = pen.glyph() if ttf else pen.getCharString()
            metrics[gn] = (width,64 if paths else 0)
        if ttf: fb.setupGlyf(glyphs)
        else: fb.setupCFF('Foldline-Regular',{'FullName':'Foldline Regular','FamilyName':'Foldline','Weight':'Regular'},glyphs,{})
        fb.setupHorizontalMetrics(metrics)
        fb.setupHorizontalHeader(ascent=820,descent=-180)
        fb.setupNameTable({'familyName':'Foldline','styleName':'Regular','uniqueFontIdentifier':'Foldline Regular 0.100', 'fullName':'Foldline Regular','psName':'Foldline-Regular','version':'Version 0.100'})
        fb.setupOS2(sTypoAscender=820,sTypoDescender=-180,sTypoLineGap=0,usWinAscent=820,usWinDescent=180,sCapHeight=692,fsType=0)
        fb.setupPost()
        pairs = [('A','V',-65),('A','W',-45),('A','T',-45),('T','A',-45),('V','A',-65),('W','A',-45),('Y','A',-60),('L','T',-35)]
        fea = 'feature kern {\n' + '\n'.join(f'pos {name(a)} {name(b)} {v};' for a,b,v in pairs if a in sources and b in sources) + '\n} kern;'
        addOpenTypeFeaturesFromString(fb.font,fea)
        fb.save(OUT / ('Foldline-Regular.ttf' if ttf else 'Foldline-Regular.otf'))
    report = {}
    for path in OUT.glob('Foldline-Regular.*'):
        if path.suffix not in ('.ttf','.otf'): continue
        font = TTFont(path,checkChecksums=2)
        assert set(font.getBestCmap()) == {ord(c) for c in sources}
        assert 'GPOS' in font
        assert all(font['hmtx'][gn][0]>0 for gn in order)
        report[path.name] = {'glyphs':len(order),'mapped_characters':len(sources),'bytes':path.stat().st_size,'outline':'glyf' if 'glyf' in font else 'CFF','kerning':'GPOS','tables':list(font.keys())}
        font.close()
    (OUT/'validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))

if __name__ == '__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--seed',action='store_true'); args=ap.parse_args()
    if args.seed: seed()
    build()
