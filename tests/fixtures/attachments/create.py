"""Deterministic small, real attachment fixtures (no network or office suite)."""
from pathlib import Path
from io import BytesIO
import zipfile,zlib
from PIL import Image,ImageDraw
ROOT=Path(__file__).parent
image=Image.new('RGB',(3000,1800),'white')
ImageDraw.Draw(image).text((100,100),'Question 6 x 7 = ?',fill='black')
for kind in ('PNG','JPEG','WEBP'):
 image.save(ROOT/('question.'+{'PNG':'png','JPEG':'jpg','WEBP':'webp'}[kind]),kind)
small=BytesIO();Image.new('RGB',(20,10),'red').save(small,'PNG');png=small.getvalue()
(ROOT/'tiny.png').write_bytes(png)

def pdf(path,count=2):
 objs=[b'',b'']; kids=[]
 for n in range(count):
  page=len(objs)+1;content=page+1;kids.append(f'{page} 0 R')
  # First page contains actual text; second is a scan-like embedded raster.
  draw=b'BT /F1 18 Tf 50 720 Td (The answer is forty-two.) Tj ET' if n%2==0 else b'q 300 0 0 150 50 500 cm /Im1 Do Q'
  objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {3+count*2} 0 R >> /XObject << /Im1 {4+count*2} 0 R >> >> /Contents {content} 0 R >>'.encode())
  objs.append(b'<< /Length '+str(len(draw)).encode()+b' >>\nstream\n'+draw+b'\nendstream')
 objs[0]=b'<< /Type /Catalog /Pages 2 0 R >>'
 objs[1]=f'<< /Type /Pages /Count {count} /Kids [{" ".join(kids)}] >>'.encode()
 objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
 raw=zlib.compress(bytes([255,0,0])*20*10)
 objs.append(b'<< /Type /XObject /Subtype /Image /Width 20 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length '+str(len(raw)).encode()+b' >>\nstream\n'+raw+b'\nendstream')
 output=b'%PDF-1.4\n';offsets=[0]
 for n,obj in enumerate(objs,1):
  offsets.append(len(output));output+=f'{n} 0 obj\n'.encode()+obj+b'\nendobj\n'
 xref=len(output);output+=f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n'.encode()
 output+=b''.join(f'{n:010d} 00000 n \n'.encode() for n in offsets[1:])
 output+=f'trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
 (ROOT/path).write_bytes(output)
pdf('pages.pdf');pdf('too-many-pages.pdf',21)

R='http://schemas.openxmlformats.org/package/2006/relationships'
D='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
S='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
P='http://schemas.openxmlformats.org/presentationml/2006/main'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
def rels(items):return f'<Relationships xmlns="{R}">'+''.join(f'<Relationship Id="{i}" Target="{target}" Type="{D}/{kind}"/>' for i,target,kind in items)+'</Relationships>'
def archive(name,entries):
 with zipfile.ZipFile(ROOT/name,'w',zipfile.ZIP_DEFLATED) as z:
  for key,value in entries.items():z.writestr(key,value)
doc={
 '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
 'word/document.xml':f'<w:document xmlns:w="{W}" xmlns:r="{D}" xmlns:a="{A}"><w:body><w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Last paragraph.</w:t></w:r><w:drawing><a:blip r:embed="picture"/></w:drawing></w:p></w:body></w:document>',
 'word/_rels/document.xml.rels':rels([('picture','media/image1.png','image')]),
 'word/media/image1.png':png,
}
archive('report.docx',doc)
archive('traversal.docx',{**doc,'../../owner.txt':'private'})
archive('dtd.docx',{**doc,'word/document.xml':f'<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><w:document xmlns:w="{W}"><w:body><w:p>&leak;</w:p></w:body></w:document>'})
archive('zipbomb.docx',{**doc,'word/bomb.bin':b'0'*1_000_000})
archive('linked.docx',{**doc,'word/_rels/document.xml.rels':f'<Relationships xmlns="{R}"><Relationship Id="picture" Type="{D}/image" Target="file:///home/nikita/.codex/auth.json" TargetMode="External"/></Relationships>'})
archive('sheet.xlsx',{
 '[Content_Types].xml':doc['[Content_Types].xml'],
 'xl/workbook.xml':f'<workbook xmlns="{S}" xmlns:r="{D}"><sheets><sheet name="Sales" sheetId="1" r:id="s1"/><sheet name="Forecast" sheetId="2" r:id="s2"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':rels([('s1','worksheets/sheet1.xml','worksheet'),('s2','worksheets/sheet2.xml','worksheet')]),
 'xl/sharedStrings.xml':f'<sst xmlns="{S}"><si><t>Apples</t></si></sst>',
 'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="B2"><f>B1*2</f><v>84</v></c></row></sheetData></worksheet>',
 'xl/worksheets/sheet2.xml':f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Next year</t></is></c><c r="B1"><v>100</v></c></row></sheetData></worksheet>',
})
archive('slides.pptx',{
 '[Content_Types].xml':doc['[Content_Types].xml'],
 'ppt/presentation.xml':f'<p:presentation xmlns:p="{P}" xmlns:r="{D}"><p:sldIdLst><p:sldId id="256" r:id="s2"/><p:sldId id="257" r:id="s1"/></p:sldIdLst></p:presentation>',
 'ppt/_rels/presentation.xml.rels':rels([('s1','slides/slide1.xml','slide'),('s2','slides/slide2.xml','slide')]),
 'ppt/slides/slide1.xml':f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Final slide.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
 'ppt/slides/slide2.xml':f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{D}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Opening slide.</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="picture"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>',
 'ppt/slides/_rels/slide2.xml.rels':rels([('picture','../media/image1.png','image')]),
 'ppt/media/image1.png':png,
})

Image.new('RGBA',(120,80),(0,0,0,0)).save(ROOT/'transparent.png')
Image.new('RGB',(100,2000),'white').save(ROOT/'too-tall.png')
# RGB random-like deterministic pixels are poorly compressible, exercising the
# binary-image budget rather than only image counts.
import random
randomizer=random.Random(42)
noise=Image.frombytes('RGB',(1200,1000),randomizer.randbytes(1200*1000*3))
noise.save(ROOT/'noise.png')
# Actual encrypted ZIP flag and POSIX symlink metadata in the central directory.
archive('encrypted.docx',doc)
raw=(ROOT/'encrypted.docx').read_bytes()
raw=bytearray(raw)
for signature,offset in [(b'PK\x03\x04',6),(b'PK\x01\x02',8)]:
 start=0
 while True:
  position=raw.find(signature,start)
  if position<0:break
  raw[position+offset]|=1;start=position+4
(ROOT/'encrypted.docx').write_bytes(raw)
with zipfile.ZipFile(ROOT/'symlink.docx','w',zipfile.ZIP_DEFLATED) as z:
 for key,value in doc.items():z.writestr(key,value)
 link=zipfile.ZipInfo('word/owner-link');link.create_system=3;link.external_attr=0o120777<<16
 z.writestr(link,'/home/nikita/.codex/auth.json')
pdf('eleven-pages.pdf',11)
rotated=Image.new('RGB',(20,10),'blue');exif=Image.Exif();exif[274]=6
rotated.save(ROOT/'rotated.png',exif=exif)
Image.new('RGB',(120,80),'white').save(ROOT/'white.png')

# Hand-authored OMML: the independent expected formula is 1/2, not 12.
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
def math_doc(name, formula):
 archive(name,{'word/document.xml':f'<w:document xmlns:w="{W}" xmlns:m="{M}"><w:body><w:p><w:r><w:t>Compute: </w:t></w:r><m:oMath>{formula}</m:oMath><w:r><w:t> = ?</w:t></w:r></w:p></w:body></w:document>'})
math_doc('fraction.docx','<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>')
math_doc('nested-math.docx','<m:f><m:num><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:num><m:den><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSub><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub></m:sSub></m:e></m:rad></m:den></m:f><m:r><m:t>+</m:t></m:r><m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>8</m:t></m:r></m:e></m:rad>')
complex_math='<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:sSup><m:e><m:r><m:t>i</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:e></m:nary>'
math_doc('complex-math.docx',complex_math)
M='http://purl.oclc.org/ooxml/officeDocument/math'
math_doc('strict-math.docx',complex_math)

# Each chart's cached value 42 is the only material, so returning empty text
# would incorrectly claim successful preparation of the task.
C='http://schemas.openxmlformats.org/drawingml/2006/chart'
chart=f'<c:chartSpace xmlns:c="{C}"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>42</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
graphic=f'<a:graphic xmlns:a="{A}" xmlns:c="{C}" xmlns:r="{D}"><a:graphicData uri="{C}"><c:chart r:id="chart"/></a:graphicData></a:graphic>'
archive('chart.docx',{'word/document.xml':f'<w:document xmlns:w="{W}"><w:body><w:p><w:drawing>{graphic}</w:drawing></w:p></w:body></w:document>','word/_rels/document.xml.rels':rels([('chart','charts/chart1.xml','chart')]),'word/charts/chart1.xml':chart})
archive('chart.xlsx',{
 'xl/workbook.xml':f'<workbook xmlns="{S}" xmlns:r="{D}"><sheets><sheet name="Chart only" sheetId="1" r:id="sheet"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':rels([('sheet','worksheets/sheet1.xml','worksheet')]),
 'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{S}" xmlns:r="{D}"><sheetData/><drawing r:id="drawing"/></worksheet>',
 'xl/worksheets/_rels/sheet1.xml.rels':rels([('drawing','../drawings/drawing1.xml','drawing')]),
 'xl/drawings/drawing1.xml':f'<drawing>{graphic}</drawing>',
 'xl/drawings/_rels/drawing1.xml.rels':rels([('chart','../charts/chart1.xml','chart')]),'xl/charts/chart1.xml':chart,
})
slide_base={
 'ppt/presentation.xml':f'<p:presentation xmlns:p="{P}" xmlns:r="{D}"><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst></p:presentation>',
 'ppt/_rels/presentation.xml.rels':rels([('slide','slides/slide1.xml','slide')]),
 'ppt/slides/slide1.xml':f'<p:sld xmlns:p="{P}"><p:cSld><p:spTree>{graphic}</p:spTree></p:cSld></p:sld>',
 'ppt/slides/_rels/slide1.xml.rels':rels([('chart','../charts/chart1.xml','chart')]),'ppt/charts/chart1.xml':chart,
}
archive('chart.pptx',slide_base)
for inherited in ('slideLayout','slideMaster'):
 tag={'slideLayout':'sldLayout','slideMaster':'sldMaster'}[inherited]
 part=f'ppt/{inherited}s/{inherited}1.xml'
 entries={**slide_base,'ppt/slides/slide1.xml':f'<p:sld xmlns:p="{P}"><p:cSld><p:spTree/></p:cSld></p:sld>',
  'ppt/slides/_rels/slide1.xml.rels':rels([('layout','../slideLayouts/slideLayout1.xml','slideLayout')]),
  'ppt/slideLayouts/slideLayout1.xml':f'<p:sldLayout xmlns:p="{P}"><p:cSld><p:spTree/></p:cSld></p:sldLayout>',
  part:f'<p:{tag} xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Only inherited material: solve 6 x 7.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:{tag}>'}
 if inherited=='slideMaster':entries['ppt/slideLayouts/_rels/slideLayout1.xml.rels']=rels([('master','../slideMasters/slideMaster1.xml','slideMaster')])
 archive(inherited+'-content.pptx',entries)
 # A chart can also live entirely on a slide layout or master.
 entries[part]=f'<p:{tag} xmlns:p="{P}"><p:cSld><p:spTree>{graphic}</p:spTree></p:cSld></p:{tag}>'
 entries[f'ppt/{inherited}s/_rels/{inherited}1.xml.rels']=rels([('chart','../charts/chart1.xml','chart')])
 archive(inherited+'-chart.pptx',entries)

archive('vector.docx',{'word/document.xml':f'<w:document xmlns:w="{W}" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>Find the shaded area.</w:t></w:r><w:pict><v:shape type="#rectangle" style="width:100pt;height:50pt" fillcolor="red"/></w:pict></w:p></w:body></w:document>'})
with zipfile.ZipFile(ROOT/'chart.xlsx') as z: drawing_sheet={name:z.read(name) for name in z.namelist()}
drawing_sheet['xl/drawings/drawing1.xml']=f'<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="{A}"><xdr:sp><xdr:txBody><a:p><a:r><a:t>Only drawing text: 42</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:wsDr>'
del drawing_sheet['xl/drawings/_rels/drawing1.xml.rels']
archive('drawing.xlsx',drawing_sheet)
archive('connector.pptx',{**slide_base,'ppt/slides/_rels/slide1.xml.rels':rels([]),'ppt/slides/slide1.xml':f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:cxnSp><p:spPr><a:prstGeom prst="bentConnector3"/></p:spPr></p:cxnSp></p:spTree></p:cSld></p:sld>'})
archive('smartart.docx',{'word/document.xml':f'<w:document xmlns:w="{W}" xmlns:a="{A}" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:r="{D}"><w:body><w:p><w:drawing><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="data"/></a:graphicData></a:graphic></w:drawing></w:p></w:body></w:document>','word/_rels/document.xml.rels':rels([('data','diagrams/data1.xml','diagramData')]),'word/diagrams/data1.xml':f'<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="{A}"><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>Only SmartArt material: 42</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>'})
