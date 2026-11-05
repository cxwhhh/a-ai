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
    return f'M{x-40} 0 L{x-40} 28 Q{x-1} 31 {x} 66 L{x} {top-69} Q{x} {top-39} {x-34} {top-37} L{x-34} {top-12} L{x+93} {top+8} L{x+93} 66 Q{x+94} 31 {x+133} 28 L{x+133} 0 Z'

oval='M258 -12 C112 -12 28 84 28 249 C28 409 125 512 270 512 C413 512 497 410 497 252 C497 89 402 -12 258 -12 Z M270 43 C350 43 389 119 389 247 C389 380 341 457 257 457 C177 457 137 379 137 252 C137 122 186 43 270 43 Z'
c='M472 416 C425 482 355 512 268 512 C121 512 28 402 28 245 C28 80 122 -12 271 -12 C370 -12 435 34 480 111 L450 135 C408 79 361 55 301 55 C199 55 139 133 139 258 C139 387 183 459 262 459 C302 459 330 443 336 409 C343 371 372 353 409 365 C440 375 461 395 472 416 Z'
e='M478 240 L139 240 C147 118 202 55 300 55 C365 55 415 84 451 134 L481 110 C433 29 363 -12 269 -12 C122 -12 28 86 28 247 C28 405 120 512 265 512 C409 512 486 410 478 240 Z M140 295 L371 295 C371 401 334 459 260 459 C186 459 149 398 140 295 Z'
# Each shoulder is a connected filled ribbon. Serifs are separately unioned.
shoulder='M{a} 370 C{b} 466 {c} 512 {d} 512 C{e} 512 {f} 454 {f} 340 L{f} 66 Q{f} 31 {g} 28 L{g} 0 L{h} 0 L{h} 28 Q{i} 31 {i} 66 L{i} 334 C{i} 406 {j} 448 {k} 448 C{l} 448 {m} 417 {a} 352 Z'
def arch(x=0):
    return shoulder.format(a=147+x,b=183+x,c=232+x,d=295+x,e=404+x,f=424+x,g=464+x,h=291+x,i=331+x,j=307+x,k=253+x,l=210+x,m=177+x)

paths={
'o':(525,oval), 'c':(505,c), 'e':(505,e),
'l':(246,stem(76)),
'h':(485,stem(65)+' '+arch(-16)),
'n':(485,stem(65,502)+' '+arch(-16)),
'd':(570,oval+' '+stem(420)),
'u':(495,'M30 502 L158 502 L158 164 C158 93 183 55 238 55 C284 55 324 86 349 135 L349 437 Q349 471 309 474 L309 502 L442 502 L442 80 Q442 46 479 43 L479 17 L356 -7 L349 83 C308 20 259 -12 194 -12 C91 -12 65 49 65 155 L65 435 Q65 470 30 474 Z'),
'r':(359,stem(65,502)+' M157 363 C189 461 233 512 292 512 C338 512 361 485 356 449 C351 412 326 397 299 406 C275 414 273 442 248 442 C210 442 180 396 157 333 Z'),
'a':(520,'M70 406 C92 479 168 512 264 512 C386 512 438 454 438 346 L438 83 Q438 47 465 47 Q481 47 493 60 L510 35 C484 4 455 -12 417 -12 Q352 -12 341 52 C300 8 251 -12 192 -12 C93 -12 32 38 32 120 C32 230 139 272 344 297 L344 350 C344 420 316 459 257 459 C212 459 191 439 184 404 C178 369 155 353 124 364 C98 372 81 390 70 406 Z M344 253 C195 233 138 197 138 132 C138 78 169 48 220 48 C267 48 311 75 344 113 Z'),
'A':(690,'M20 0 L20 28 Q71 37 97 100 L318 722 L366 722 L604 91 Q627 37 675 28 L675 0 L417 0 L417 28 Q490 32 472 84 L413 253 L184 253 L129 94 Q112 40 187 28 L187 0 Z M204 309 L393 309 L299 582 Z'),
'C':(720,'M651 531 L610 531 C581 636 514 677 420 677 C254 677 171 558 171 361 C171 156 258 44 416 44 C516 44 589 98 631 198 L673 179 C618 45 528 -14 395 -14 C174 -14 39 133 39 356 C39 582 192 736 407 736 C489 736 552 713 601 683 L620 724 L651 724 Z'),
}

for ch,(width,d) in paths.items():
    p=pathops.Path();parse_path(d,p.getPen());p=pathops.simplify(p)
    pen=SVGPathPen(None);p.draw(TransformPen(pen,(1,0,0,-1,0,800)))
    (ROOT/'svg'/f'U{ord(ch):04X}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 1000" data-advance="{width}"><path d="{pen.getCommands()}"/></svg>',encoding='utf-8')

# Reuse the tested table builder, giving this direction its own family and files.
source=(ROOT.parent.parent/'build.py').read_text(encoding='utf-8').replace('Foldline','AureoleDisplay')
source=source.replace('0.100','0.200')
source=source.replace("pairs = [('A'", "pairs = [('r','e',-18),('r','o',-18),('l','a',-8),('C','l',-12),('a','u',-8),('o','l',-8),('A','u',-24),('A'")
source=source.replace("assert 'GPOS' in font", "assert 'GPOS' in font").replace("'kerning':'GPOS'", "'kerning':'7 study pairs + inherited compatible pairs'")
source=source.replace('sCapHeight=692','sCapHeight=722')
source=source.replace("metrics[gn] = (width,64 if paths else 0)","\n            from fontTools.pens.boundsPen import BoundsPen\n            bp=BoundsPen(None); draw(paths,bp)\n            metrics[gn] = (width, round(bp.bounds[0]) if bp.bounds else 0)")
ns={'__file__':str(ROOT/'compiler.py'),'__name__':'aureole_compiler'}
exec(compile(source,str(ROOT/'compiler.py'),'exec'),ns)
ns['build']()

im=Image.new('RGB',(1800,1240),'#f3eee4');dr=ImageDraw.Draw(im)
ui=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',20)
dr.text((94,65),'DIRECTION 03     /     SOFTER CONTRAST, FULLER CURVES     /     12 LETTERS + SPACE',font=ui,fill='#776e60')
font=lambda s:ImageFont.truetype(str(ROOT/'dist/AureoleDisplay-Regular.ttf'),s)
dr.text((82,125),'Aureole',font=font(260),fill='#302c28')
dr.text((96,425),'a slower cadence',font=ui,fill='#8b604b')
dr.line((96,480,1704,480),fill='#c9bfaf',width=1)
dr.text((90,510),'Claude',font=font(175),fill='#a7583c')
dr.text((830,510),'candle',font=font(175),fill='#302c28')
dr.text((96,757),'a c d e h l n o r u',font=font(98),fill='#302c28')
dr.text((96,940),'Aa   Cc   oo   ee   nn',font=font(105),fill='#302c28')
dr.text((96,1150),'Custom cubic outlines / soft bracketed serifs / warm editorial contrast',font=ui,fill='#776e60')
im.save(ROOT/'direction-03.png')
for ext in ('ttf','otf'):
    assert ImageFont.truetype(str(ROOT/f'dist/AureoleDisplay-Regular.{ext}'),100).getmask('Aureole').getbbox()

compare=Image.new('RGB',(1800,1050),'#f3eee4');cd=ImageDraw.Draw(compare)
cd.text((90,45),'02 / BEFORE',font=ui,fill='#776e60')
old=ImageFont.truetype(str(ROOT.parent/'dist/Aureole-Regular.ttf'),190)
cd.text((80,100),'Aureole',font=old,fill='#302c28')
cd.text((900,115),'Claude',font=ImageFont.truetype(str(ROOT.parent/'dist/Aureole-Regular.ttf'),145),fill='#302c28')
cd.line((90,380,1710,380),fill='#c9bfaf')
cd.text((90,425),'03 / REFINED',font=ui,fill='#a7583c')
cd.text((80,480),'Aureole',font=font(190),fill='#a7583c')
cd.text((900,495),'Claude',font=font(145),fill='#a7583c')
cd.text((90,830),'a e o r n',font=font(110),fill='#302c28')
cd.text((870,850),'Fuller bowls / stronger hairlines / shaped terminals',font=ui,fill='#776e60')
compare.save(ROOT/'comparison.png')
