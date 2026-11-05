"""Hand-drawn serif direction study: cubic outlines, no imported font outlines."""
from pathlib import Path
import importlib.util
import pathops
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent
(ROOT/'svg').mkdir(parents=True,exist_ok=True)

def stem(x,top=720):
    return f'M{x-38} 0 L{x-38} 18 Q{x} 20 {x} 58 L{x} {top-60} Q{x} {top-30} {x-35} {top-28} L{x-35} {top-10} L{x+82} {top+8} L{x+82} 58 Q{x+82} 20 {x+120} 18 L{x+120} 0 Z'

oval='M250 -12 C112 -12 35 85 35 244 C35 400 122 502 260 502 C396 502 475 403 475 250 C475 91 388 -12 250 -12 Z M260 21 C340 21 376 111 376 245 C376 379 332 468 250 468 C171 468 134 381 134 247 C134 112 178 21 260 21 Z'
c='M452 412 C403 480 341 502 258 502 C117 502 35 394 35 240 C35 83 122 -12 263 -12 C351 -12 413 29 459 100 L436 120 C395 67 347 42 291 42 C190 42 135 124 135 253 C135 391 180 469 259 469 C302 469 325 454 334 411 C341 375 370 359 402 370 C426 378 443 393 452 412 Z'
e='M456 251 L136 251 C139 111 194 42 288 42 C350 42 401 70 438 120 L460 101 C414 25 346 -12 260 -12 C120 -12 35 86 35 244 C35 397 119 502 257 502 C393 502 461 404 456 251 Z M139 288 L358 288 C361 404 321 468 253 468 C181 468 145 398 139 288 Z'
# Each shoulder is a connected filled ribbon. Serifs are separately unioned.
shoulder='M{a} 370 C{b} 462 {c} 502 {d} 502 C{e} 502 {f} 451 {f} 340 L{f} 58 Q{f} 20 {g} 18 L{g} 0 L{h} 0 L{h} 18 Q{i} 20 {i} 58 L{i} 338 C{i} 413 {j} 450 {k} 450 C{l} 450 {m} 421 {a} 356 Z'
def arch(x=0):
    return shoulder.format(a=136+x,b=175+x,c=224+x,d=285+x,e=391+x,f=409+x,g=447+x,h=290+x,i=327+x,j=306+x,k=252+x,l=205+x,m=167+x)

paths={
'o':(510,oval), 'c':(490,c), 'e':(490,e),
'l':(250,stem(82)),
'h':(485,stem(70)+' '+arch(-16)),
'n':(485,stem(70,490)+' '+arch(-16)),
'd':(560,oval+' '+stem(408)),
'u':(485,'M34 490 L150 490 L150 155 C150 81 174 41 230 41 C280 41 320 74 345 123 L345 438 Q345 471 306 472 L306 490 L428 490 L428 68 Q428 34 465 32 L465 14 L351 -7 L345 80 C306 20 259 -12 197 -12 C103 -12 67 45 67 150 L67 434 Q67 469 34 472 Z'),
'r':(355,stem(70,490)+' M152 361 C187 456 228 502 286 502 C329 502 348 479 346 446 C344 410 323 394 297 399 C270 402 269 433 243 436 C206 439 176 397 152 338 Z'),
'a':(510,'M78 403 C99 471 166 502 256 502 C367 502 418 450 418 348 L418 72 Q418 33 452 33 Q466 33 478 44 L487 23 C468 2 441 -10 409 -10 Q347 -10 338 51 C300 10 252 -12 198 -12 C104 -12 44 38 44 117 C44 225 139 262 337 290 L337 352 C337 428 308 470 251 470 C205 470 188 448 181 411 C175 381 156 366 126 373 C104 378 88 388 78 403 Z M337 254 C193 234 139 195 139 126 C139 67 168 38 218 38 C261 38 303 64 337 107 Z'),
'A':(680,'M20 0 L20 20 Q70 29 97 92 L322 722 L358 722 L590 84 Q613 29 661 20 L661 0 L419 0 L419 20 Q491 24 474 76 L412 253 L178 253 L119 85 Q102 32 180 20 L180 0 Z M192 292 L398 292 L296 589 Z'),
'C':(720,'M648 537 L619 537 C590 651 517 698 420 698 C250 698 161 569 161 361 C161 144 250 24 414 24 C521 24 597 83 640 188 L669 176 C617 44 528 -14 395 -14 C178 -14 45 133 45 356 C45 580 192 736 407 736 C488 736 552 713 601 683 L620 724 L648 724 Z'),
}

for ch,(width,d) in paths.items():
    p=pathops.Path();parse_path(d,p.getPen());p=pathops.simplify(p)
    pen=SVGPathPen(None);p.draw(TransformPen(pen,(1,0,0,-1,0,800)))
    (ROOT/'svg'/f'U{ord(ch):04X}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 1000" data-advance="{width}"><path d="{pen.getCommands()}"/></svg>',encoding='utf-8')

# Reuse the tested table builder, giving this direction its own family and files.
source=(ROOT.parent/'build.py').read_text(encoding='utf-8').replace('Foldline','Aureole')
source=source.replace("assert 'GPOS' in font", "assert 'cmap' in font").replace("'kerning':'GPOS'", "'kerning':'not tuned'")
source=source.replace("metrics[gn] = (width,64 if paths else 0)","\n            from fontTools.pens.boundsPen import BoundsPen\n            bp=BoundsPen(None); draw(paths,bp)\n            metrics[gn] = (width, round(bp.bounds[0]) if bp.bounds else 0)")
ns={'__file__':str(ROOT/'compiler.py'),'__name__':'aureole_compiler'}
exec(compile(source,str(ROOT/'compiler.py'),'exec'),ns)
ns['build']()

im=Image.new('RGB',(1800,1240),'#f3eee4');dr=ImageDraw.Draw(im)
ui=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',20)
dr.text((94,65),'DIRECTION 02     /     ORIGINAL SERIF STUDY     /     13 GLYPHS',font=ui,fill='#776e60')
font=lambda s:ImageFont.truetype(str(ROOT/'dist/Aureole-Regular.ttf'),s)
dr.text((82,125),'Aureole',font=font(260),fill='#302c28')
dr.text((96,425),'a slower cadence',font=ui,fill='#8b604b')
dr.line((96,480,1704,480),fill='#c9bfaf',width=1)
dr.text((90,510),'Claude',font=font(175),fill='#a7583c')
dr.text((830,510),'candle',font=font(175),fill='#302c28')
dr.text((96,757),'a c d e h l n o r u',font=font(98),fill='#302c28')
dr.text((96,940),'Aa   Cc   oo   ee   nn',font=font(105),fill='#302c28')
dr.text((96,1150),'Custom cubic outlines / soft bracketed serifs / warm editorial contrast',font=ui,fill='#776e60')
im.save(ROOT/'direction-02.png')
for ext in ('ttf','otf'):
    assert ImageFont.truetype(str(ROOT/f'dist/Aureole-Regular.{ext}'),100).getmask('Aureole').getbbox()
