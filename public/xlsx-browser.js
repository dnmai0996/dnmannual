(function(){
// 외부 패키지 없이 표준 XLSX(OOXML ZIP) 파일을 생성합니다.

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function columnName(index) {
  let value = Number(index);
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function normalizeSheetName(name, used) {
  let result = String(name || 'Sheet').replace(/[\\/*?:\[\]]/g, ' ').trim() || 'Sheet';
  result = result.slice(0, 31);
  const base = result;
  let suffix = 2;
  while (used.has(result)) {
    const tail = ` ${suffix}`;
    result = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(result);
  return result;
}

function cellXml(address, value, style = 3) {
  if (value == null) return `<c r="${address}" s="${style}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${address}" s="${style === 3 ? 4 : style}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${address}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = xmlEscape(value);
  return `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function worksheetXml(sheet) {
  const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const columnCount = Math.max(1, headers.length, ...rows.map((row) => row.length));
  const title = sheet.title || sheet.name;
  const subtitle = sheet.subtitle || '';
  const headerRow = 4;
  const dataStart = 5;
  const lastColumn = columnName(columnCount);
  const lastRow = Math.max(headerRow, dataStart + rows.length - 1);
  const widths = Array.from({ length: columnCount }, (_, i) => {
    const proposed = Number(sheet.widths?.[i]);
    if (Number.isFinite(proposed) && proposed > 0) return Math.min(60, proposed);
    const values = [headers[i] || '', ...rows.slice(0, 200).map((row) => row[i] ?? '')];
    const length = Math.max(...values.map((value) => String(value).length), 8);
    return Math.min(40, Math.max(10, length * 1.15));
  });

  const rowXml = [];
  rowXml.push(`<row r="1" ht="28" customHeight="1">${cellXml('A1', title, 1)}</row>`);
  rowXml.push(`<row r="2" ht="19" customHeight="1">${cellXml('A2', subtitle, 5)}</row>`);
  rowXml.push('<row r="3" ht="7" customHeight="1"/>');
  rowXml.push(`<row r="${headerRow}" ht="24" customHeight="1">${headers.map((header, i) => cellXml(`${columnName(i + 1)}${headerRow}`, header, 2)).join('')}</row>`);

  rows.forEach((row, rowIndex) => {
    const r = dataStart + rowIndex;
    const cells = Array.from({ length: columnCount }, (_, i) => {
      const value = row[i];
      const style = typeof value === 'number' && Number.isFinite(value) ? 4 : 3;
      return cellXml(`${columnName(i + 1)}${r}`, value, style);
    }).join('');
    rowXml.push(`<row r="${r}">${cells}</row>`);
  });

  const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width.toFixed(2)}" customWidth="1"/>`).join('');
  const autoFilter = headers.length ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastRow}"/>` : '';
  const merges = columnCount > 1
    ? `<mergeCells count="2"><mergeCell ref="A1:${lastColumn}1"/><mergeCell ref="A2:${lastColumn}2"/></mergeCells>`
    : '';
  const tabColor = sheet.tabColor ? `<tabColor rgb="${xmlEscape(sheet.tabColor)}"/>` : '';

  return `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr>${tabColor}<outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${cols}</cols>
  <sheetData>${rowXml.join('')}</sheetData>
  ${autoFilter}
  ${merges}
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

function stylesXml() {
  return `${XML_HEADER}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0;-0.0;0.0"/></numFmts>
  <fonts count="4">
    <font><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
    <font><b/><color rgb="FF17365D"/><sz val="18"/><name val="맑은 고딕"/><family val="2"/></font>
    <font><color rgb="FF666666"/><sz val="9"/><name val="맑은 고딕"/><family val="2"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E1E8"/></left><right style="thin"><color rgb="FFD9E1E8"/></right><top style="thin"><color rgb="FFD9E1E8"/></top><bottom style="thin"><color rgb="FFD9E1E8"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { dosTime, dosDate };
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value));
}

function concatBytes(parts) {
  const arrays = parts.map(toBytes);
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function writeU16(view, offset, value) { view.setUint16(offset, value, true); }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const file of files) {
    const name = toBytes(file.name);
    const data = toBytes(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    writeU32(lv, 0, 0x04034B50); writeU16(lv, 4, 20); writeU16(lv, 6, 0x0800); writeU16(lv, 8, 0);
    writeU16(lv, 10, dosTime); writeU16(lv, 12, dosDate); writeU32(lv, 14, crc);
    writeU32(lv, 18, data.length); writeU32(lv, 22, data.length); writeU16(lv, 26, name.length); writeU16(lv, 28, 0);
    localParts.push(local, name, data);

    const central = new Uint8Array(46);
    const cv = new DataView(central.buffer);
    writeU32(cv, 0, 0x02014B50); writeU16(cv, 4, 20); writeU16(cv, 6, 20); writeU16(cv, 8, 0x0800); writeU16(cv, 10, 0);
    writeU16(cv, 12, dosTime); writeU16(cv, 14, dosDate); writeU32(cv, 16, crc); writeU32(cv, 20, data.length); writeU32(cv, 24, data.length);
    writeU16(cv, 28, name.length); writeU16(cv, 30, 0); writeU16(cv, 32, 0); writeU16(cv, 34, 0); writeU16(cv, 36, 0);
    writeU32(cv, 38, 0); writeU32(cv, 42, offset);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralBuffer = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  writeU32(ev, 0, 0x06054B50); writeU16(ev, 4, 0); writeU16(ev, 6, 0); writeU16(ev, 8, files.length); writeU16(ev, 10, files.length);
  writeU32(ev, 12, centralBuffer.length); writeU32(ev, 16, offset); writeU16(ev, 20, 0);
  return concatBytes([...localParts, centralBuffer, end]);
}

function buildXlsx(inputSheets, options = {}) {
  const usedNames = new Set();
  const sheets = inputSheets.map((sheet) => ({ ...sheet, name: normalizeSheetName(sheet.name, usedNames) }));
  const creator = xmlEscape(options.creator || '통합 연차관리 시스템');
  const modified = new Date().toISOString();
  const sheetOverrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const workbookSheets = sheets.map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const worksheetRels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const stylesRelId = sheets.length + 1;

  const files = [
    {
      name: '[Content_Types].xml',
      data: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
    },
    {
      name: '_rels/.rels',
      data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
    },
    {
      name: 'docProps/core.xml',
      data: `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${creator}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${modified}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified></cp:coreProperties>`
    },
    {
      name: 'docProps/app.xml',
      data: `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><AppVersion>16.0000</AppVersion><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((sheet) => `<vt:lpstr>${xmlEscape(sheet.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>${workbookSheets}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${worksheetRels}<Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: 'xl/styles.xml', data: stylesXml() }
  ];

  sheets.forEach((sheet, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(sheet) }));
  return makeZip(files);
}

window.LeaveXlsx = { buildXlsx, makeZip, xmlEscape, columnName };

})();
