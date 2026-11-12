"""Fixed trusted parser payload. Executed only inside runner.py's namespace.

Uploaded data never reaches a host parser. All decoded images remain in memory;
no archive member is ever extracted to disk, and no relationship is fetched.
"""
import sys
sys.path.insert(0, '/opt/packages')
import base64
import io
import json
import warnings
import posixpath
import stat
import zipfile
import xml.etree.ElementTree as ET
from contextlib import closing
from PIL import Image, ImageOps

MAX_TEXT = 500_000
MAX_IMAGES = 20
MAX_IMAGE_BYTES = 6_000_000
SPLIT = 'Материалы превышают лимит. Разделите их на несколько заданий.'
INVALID = 'Не удалось прочитать файл. Проверьте формат или разделите материалы.'
PDF_EXPORT = 'Документ содержит диаграммы, SmartArt или неподдерживаемые рисунки. Экспортируйте его в PDF и отправьте снова.'
class Rejected(Exception): pass
class Limit(Rejected): pass
class UnsupportedOffice(Rejected): pass

images = []
image_bytes = 0

def add_image(data):
    global image_bytes
    if len(images) >= MAX_IMAGES: raise Limit()
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    Image.MAX_IMAGE_PIXELS = 32_000_000
    with Image.open(io.BytesIO(data)) as source:
        if source.format not in ('PNG', 'JPEG', 'WEBP') or getattr(source, 'n_frames', 1) != 1:
            raise Rejected()
        source.load()
        image = ImageOps.exif_transpose(source)
        if max(image.size)/min(image.size) > 5: raise Limit()
        image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        # Composite transparent screenshots on white so formula ink stays
        # legible. PNG preserves screenshot edges; JPEG bounds photographs.
        if image.mode in ('RGBA', 'LA') or 'transparency' in image.info:
            rgba = image.convert('RGBA')
            background = Image.new('RGB', image.size, 'white')
            background.paste(rgba, mask=rgba.getchannel('A'))
            image = background
        if source.format == 'PNG':
            image.convert('RGB').save(output, format='PNG')
            mime = 'image/png'
        else:
            image.convert('RGB').save(output, format='JPEG', quality=85, optimize=False)
            mime = 'image/jpeg'
        result = output.getvalue()
    image_bytes += len(result)
    if image_bytes > MAX_IMAGE_BYTES: raise Limit()
    images.append({'mime': mime, 'base64': base64.b64encode(result).decode('ascii')})
    return '[Image '+str(len(images))+']'

def local(tag):
    return tag.rsplit('}', 1)[-1]

def attr(element, name):
    return next((value for key, value in element.attrib.items() if key.endswith('}'+name)), element.get(name))

MATH = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

def math_latex(node, depth=0):
    # Only recognized structures are translated. An unknown structure preserves
    # the entire formula as OMML below, never its concatenated text descendants.
    if depth > 64 or not node.tag.startswith('{'+MATH+'}'): raise Rejected()
    kind = local(node.tag)
    def render(child): return math_latex(child, depth+1)
    if kind == 't':
        if len(node): raise Rejected()
        return ''.join({'\\': r'\backslash ', '{': r'\{', '}': r'\}', '_': r'\_', '^': r'\^{}', '%': r'\%', '#': r'\#', '&': r'\&', '$': r'\$', '~': r'\~{}'}.get(c, c) for c in (node.text or ''))
    if kind in ('oMath', 'r', 'num', 'den', 'e', 'sup', 'sub', 'deg'):
        return ''.join(render(child) for child in node)
    if kind == 'f':
        if [local(child.tag) for child in node] != ['num', 'den']: raise Rejected()
        return r'\frac{'+render(node[0])+'}{'+render(node[1])+'}'
    if kind in ('sSup', 'sSub', 'sSubSup'):
        expected = {'sSup': ['e', 'sup'], 'sSub': ['e', 'sub'], 'sSubSup': ['e', 'sub', 'sup']}[kind]
        if [local(child.tag) for child in node] != expected: raise Rejected()
        base = '{'+render(node[0])+'}'
        if kind in ('sSub', 'sSubSup'): base += '_{'+render(node[1])+'}'
        if kind in ('sSup', 'sSubSup'): base += '^{'+render(node[-1])+'}'
        return base
    if kind == 'rad':
        children = list(node)
        hide_degree = False
        if children and local(children[0].tag) == 'radPr':
            properties = children.pop(0)
            if len(properties) != 1 or local(properties[0].tag) != 'degHide': raise Rejected()
            value = attr(properties[0], 'val')
            if value not in ('0', '1', 'true', 'false', 'on', 'off'): raise Rejected()
            hide_degree = value in ('1', 'true', 'on')
        if [local(child.tag) for child in children] != ['deg', 'e']: raise Rejected()
        degree = render(children[0])
        if hide_degree and degree: raise Rejected()
        return r'\sqrt'+('['+degree+']' if degree else '')+'{'+render(children[1])+'}'
    raise Rejected()

def formula(node):
    try: return r'\('+math_latex(node)+r'\)'
    except Rejected:
        return '\n[Office Math — complete structured OMML XML]\n'+ET.tostring(node, encoding='unicode')+'\n[/Office Math]\n'

class NoDTD(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise Rejected()

class Office:
    def __init__(self, data):
        self.archive = zipfile.ZipFile(io.BytesIO(data))
        members = self.archive.infolist()
        if len(members) > 2000: raise Limit()
        self.members = {}
        self.trees = {}
        total = 0
        for item in members:
            path = item.filename
            mode = item.external_attr >> 16
            if (item.flag_bits & 1 or stat.S_ISLNK(mode) or '\\' in path or '\x00' in path
                or path.startswith('/') or '..' in path.split('/') or ':' in path
                or path in self.members): raise Rejected()
            if item.is_dir(): continue
            total += item.file_size
            if item.file_size > 20_000_000 or total > 50_000_000 or item.file_size > max(1, item.compress_size)*200: raise Limit()
            if 'vbaproject' in path.lower() or '/embeddings/' in path.lower(): raise Rejected()
            self.members[path] = item
        # Validate every XML member, not merely the parts displayed below.
        # DTDs are rejected by the XML parser for any source encoding.
        for path in self.members:
            if path.lower().endswith(('.xml', '.rels')):
                self.trees[path] = ET.fromstring(self.bytes(path), parser=ET.XMLParser(target=NoDTD()))

    def bytes(self, path):
        item = self.members.get(path)
        if item is None: raise Rejected()
        with self.archive.open(item) as stream:
            data = stream.read(min(item.file_size, 20_000_000)+1)
            if len(data) != item.file_size: raise Rejected()
            return data

    def tree(self, path):
        if path not in self.trees: raise Rejected()
        return self.trees[path]

    def relationships(self, source):
        directory, name = posixpath.split(source)
        path = posixpath.join(directory, '_rels', name+'.rels')
        if path not in self.trees: return {}
        result = {}
        for item in self.tree(path):
            if local(item.tag) != 'Relationship': continue
            key = item.get('Id')
            if key in result: raise Rejected()
            # External links remain inert. A linked image raises an error when
            # referenced, rather than silently dropping a meaningful figure.
            target = item.get('Target', '')
            if item.get('TargetMode') == 'External':
                result[key] = (None, item.get('Type', ''))
                continue
            if '\\' in target or ':' in target or '\x00' in target: raise Rejected()
            path = posixpath.normpath(posixpath.join(directory, target)) if not target.startswith('/') else target[1:]
            if path == '..' or path.startswith('../') or path not in self.members: raise Rejected()
            result[key] = (path, item.get('Type', ''))
        return result

    def related(self, source, key):
        relation = self.relationships(source).get(key)
        if relation is None or relation[0] is None: raise Rejected()
        return relation[0]

    def inline(self, element, source):
        parts = []
        def visit(node):
            kind = local(node.tag)
            if kind == 'oMath' or (node.tag.startswith(('{'+MATH+'}', '{http://purl.oclc.org/ooxml/officeDocument/math}')) and kind != 'oMathPara'):
                parts.append(formula(node))
            elif kind == 't': parts.append(node.text or '')
            elif kind == 'tab': parts.append('\t')
            elif kind in ('br', 'cr'): parts.append('\n')
            elif kind == 'blip':
                target = self.related(source, attr(node, 'embed') or attr(node, 'link'))
                parts.append(add_image(self.bytes(target)))
            elif kind == 'imagedata':
                target = self.related(source, attr(node, 'id'))
                parts.append(add_image(self.bytes(target)))
            elif kind in ('altChunk', 'OLEObject', 'object'):
                raise Rejected()
            else:
                for child in node: visit(child)
        visit(element)
        return ''.join(parts)

    def word_blocks(self, parent, source):
        blocks = []
        for node in parent:
            kind = local(node.tag)
            if kind == 'p': blocks.append(self.inline(node, source))
            elif kind == 'tbl':
                for row in node:
                    if local(row.tag) != 'tr': continue
                    blocks.append('\t'.join(self.word_blocks(cell, source) for cell in row if local(cell.tag) == 'tc'))
            elif kind in ('altChunk', 'object'): raise Rejected()
            else:
                text = self.word_blocks(node, source)
                if text: blocks.append(text)
        return '\n'.join(blocks)

    def word(self):
        source = 'word/document.xml'
        body = next((node for node in self.tree(source) if local(node.tag) == 'body'), None)
        if body is None: raise Rejected()
        parts = [self.word_blocks(body, source)]
        for path in self.members:
            if path.startswith('word/') and posixpath.basename(path).startswith(('header', 'footer', 'footnotes', 'endnotes', 'comments')) and path.endswith('.xml'):
                parts.append(self.word_blocks(self.tree(path), path))
        return '\n'.join(parts)

    def pictures(self, source):
        parts = []
        for node in self.tree(source).iter():
            if local(node.tag) == 'blip':
                target = self.related(source, attr(node, 'embed') or attr(node, 'link'))
                parts.append(add_image(self.bytes(target)))
        return '\n'.join(parts)

    def sheet(self):
        source = 'xl/workbook.xml'
        strings = []
        if 'xl/sharedStrings.xml' in self.members:
            strings = [''.join(node.text or '' for node in item.iter() if local(node.tag) == 't') for item in self.tree('xl/sharedStrings.xml') if local(item.tag) == 'si']
        sheets = []
        for item in self.tree(source).iter():
            if local(item.tag) != 'sheet': continue
            path = self.related(source, attr(item, 'id'))
            rows = [item.get('name', '')]
            for row in self.tree(path).iter():
                if local(row.tag) != 'row': continue
                cells = []
                for cell in row:
                    if local(cell.tag) != 'c': continue
                    value = next((node.text or '' for node in cell if local(node.tag) == 'v'), '')
                    formula = next((node.text or '' for node in cell if local(node.tag) == 'f'), None)
                    if cell.get('t') == 's':
                        index = int(value)
                        if index < 0 or index >= len(strings): raise Rejected()
                        value = strings[index]
                    elif cell.get('t') == 'inlineStr':
                        value = ''.join(node.text or '' for node in cell.iter() if local(node.tag) == 't')
                    if formula is not None:
                        value = '='+formula+' [cached: '+value+']'
                    cells.append(cell.get('r', '?')+': '+value)
                rows.append('\t'.join(cells))
            # Worksheet drawings are inert relationships, never filesystem paths.
            for drawing in self.tree(path).iter():
                if local(drawing.tag) in ('drawing', 'legacyDrawing'):
                    drawing_path = self.related(path, attr(drawing, 'id'))
                    rows.append(self.pictures(drawing_path))
            sheets.append('\n'.join(rows))
        if not sheets: raise Rejected()
        return '\n\n'.join(sheets)

    def slide_content(self, source):
        # Text paragraphs/table cells and picture placeholders follow XML shape
        # order. Text is not collected with a second, duplicating traversal.
        def visit(node):
            kind = local(node.tag)
            if kind == 'p': return self.inline(node, source)
            if kind == 'blip': return self.inline(node, source)
            if kind in ('oleObj', 'contentPart'): raise Rejected()
            return '\n'.join(text for child in node if (text := visit(child)))
        return visit(self.tree(source))

    def slides(self):
        source = 'ppt/presentation.xml'
        slides = []
        for item in self.tree(source).iter():
            if local(item.tag) != 'sldId': continue
            path = self.related(source, attr(item, 'id'))
            text = 'Slide '+str(len(slides)+1)+'\n'+self.slide_content(path)
            for related, kind in self.relationships(path).values():
                if kind.endswith('/notesSlide'):
                    if related is None: raise Rejected()
                    text += '\nNotes\n'+self.slide_content(related)
            slides.append(text)
        if not slides: raise Rejected()
        return '\n\n'.join(slides)

    def read(self):
        self.check_content()
        if 'word/document.xml' in self.members: return self.word()
        if 'xl/workbook.xml' in self.members: return self.sheet()
        if 'ppt/presentation.xml' in self.members: return self.slides()
        raise Rejected()

    def check_content(self):
        # Traverse the package relationship graph, including slide layouts and
        # masters. Reject before extracting anything if any reachable material
        # cannot be faithfully represented; cached chart values are not images.
        roots = [path for path in ('word/document.xml', 'xl/workbook.xml', 'ppt/presentation.xml') if path in self.members]
        # word() also reads these annotation parts, even in minimalist packages
        # that omit a relationship; apply the same completeness checks to them.
        roots += [path for path in self.trees if path.startswith('word/') and posixpath.basename(path).startswith(('header', 'footer', 'footnotes', 'endnotes', 'comments')) and path.endswith('.xml')]
        pending = roots[:]
        seen = set()
        while pending:
            source = pending.pop()
            if source in seen: continue
            seen.add(source)
            if source in self.trees:
                root = self.tree(source)
                inherited = local(root.tag) in ('sldLayout', 'sldMaster', 'notesMaster', 'handoutMaster')
                for node in root.iter():
                    kind = local(node.tag)
                    namespace = node.tag.split('}')[0].lstrip('{')
                    if inherited and ((kind == 't' and node.text) or kind in ('blip', 'imagedata', 'graphicData', 'prstGeom', 'custGeom', 'cxnSp')):
                        raise UnsupportedOffice()
                    if kind in ('wsp', 'cxnSp', 'grpSp', 'custGeom'): raise UnsupportedOffice()
                    if kind in ('sp', 'graphicFrame') and namespace.endswith('/spreadsheetDrawing'): raise UnsupportedOffice()
                    if kind == 'drawing' and namespace.endswith('/wordprocessingml/2006/main') and not any(local(child.tag) == 'blip' for child in node.iter()):
                        raise UnsupportedOffice()
                    if kind == 'sp' and namespace.endswith('/presentationml/2006/main'):
                        shapes = list(node.iter())
                        if any(local(child.tag) == 'prstGeom' for child in shapes) and not any(attr(child, 'txBox') in ('1', 'true') for child in shapes):
                            raise UnsupportedOffice()
                    if namespace == 'urn:schemas-microsoft-com:vml' and kind == 'shape':
                        if not any(local(child.tag) == 'imagedata' for child in node.iter()) or any(local(child.tag) == 'textbox' for child in node.iter()):
                            raise UnsupportedOffice()
                    if namespace == 'urn:schemas-microsoft-com:vml' and kind in ('rect', 'roundrect', 'oval', 'line', 'polyline', 'curve', 'arc', 'group'):
                        raise UnsupportedOffice()
                    if ('/chart' in namespace or '/diagram' in namespace or kind in ('chart', 'chartEx', 'relIds')):
                        raise UnsupportedOffice()
                    if kind == 'graphicData' and node.get('uri') not in (
                        'http://schemas.openxmlformats.org/drawingml/2006/picture',
                        'http://schemas.openxmlformats.org/drawingml/2006/table',
                    ): raise UnsupportedOffice()
            for related, kind in self.relationships(source).values():
                relation = kind.rsplit('/', 1)[-1].lower()
                if relation.startswith(('chart', 'diagram')): raise UnsupportedOffice()
                if related is not None: pending.append(related)

def read(data, name, mime):
    if data.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff')) or (data[:4] == b'RIFF' and data[8:12] == b'WEBP'):
        add_image(data)
        return ''
    if data.startswith(b'%PDF-'):
        import pypdfium2 as pdfium
        parts = []
        with closing(pdfium.PdfDocument(data)) as document:
            if not len(document): raise Rejected()
            if len(document) > 20: raise Limit()
            for index in range(len(document)):
                with closing(document[index]) as page:
                    with closing(page.get_textpage()) as textpage:
                        text = textpage.get_text_bounded(errors='strict')
                    parts.append('Page '+str(index+1)+'\n'+text)
                    if len('\n\n'.join(parts).encode('utf-8')) > MAX_TEXT: raise Limit()
                    width, height = page.get_size()
                    if not (width > 0 and height > 0): raise Rejected()
                    # Render all pages, even text pages with meaningful figures.
                    # The longer edge is bounded before allocating the bitmap.
                    with closing(page.render(scale=min(2, 2048/max(width, height)))) as bitmap:
                        output = io.BytesIO()
                        bitmap.to_pil().save(output, format='PNG')
                        add_image(output.getvalue())
        return '\n\n'.join(parts)
    if data.startswith(b'PK'):
        return Office(data).read()
    extension = posixpath.splitext(name.lower())[1]
    text_extensions = {'.txt', '.csv', '.tsv', '.md', '.markdown', '.json', '.jsonl', '.ndjson', '.log', '.xml', '.html', '.htm', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sql', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.cs', '.fs', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.sh', '.bash', '.zsh', '.css', '.scss', '.tex', '.r', '.swift'}
    text_mimes = {'application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-yaml', 'application/toml', 'application/sql'}
    if mime.startswith('image/') or extension in {'.pdf', '.docx', '.xlsx', '.pptx', '.jpg', '.jpeg', '.png', '.webp'}:
        raise Rejected()
    if extension not in text_extensions and not mime.startswith('text/') and mime not in text_mimes:
        raise Rejected()
    text = data.decode('utf-8-sig')
    if any(ord(c) < 32 and c not in '\r\n\t\f' for c in text): raise Rejected()
    return text

try:
    request = json.loads(sys.stdin.buffer.read(70000))
    data = open('/attachments/input', 'rb').read(20_000_001)
    if len(data) > 20_000_000: raise Limit()
    text = read(data, request['name'], request['mime'])
    if len(text.encode('utf-8')) > MAX_TEXT: raise Limit()
    print(json.dumps({'text': text, 'images': images}, ensure_ascii=False))
except Limit:
    print(json.dumps({'text': '', 'images': [], 'error': SPLIT}, ensure_ascii=False))
except UnsupportedOffice:
    print(json.dumps({'text': '', 'images': [], 'error': PDF_EXPORT}, ensure_ascii=False))
except BaseException:
    print(json.dumps({'text': '', 'images': [], 'error': INVALID}, ensure_ascii=False))
