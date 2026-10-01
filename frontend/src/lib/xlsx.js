// PXL Classroom - Native client-side XLSX generator.
// Generates standard ECMA-376 / OpenXML spreadsheets (.xlsx) with:
// - Native clickable hyperlinks for URLs
// - Auto-calculated column widths
// - Multi-line cell text wrapping
// - Clean typography and header styling
// Zero external dependencies, pure standard web APIs.

function xmlEscape(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function colToLetter(colIdx) {
  let temp = colIdx + 1
  let letter = ''
  while (temp > 0) {
    const mod = (temp - 1) % 26
    letter = String.fromCharCode(65 + mod) + letter
    temp = Math.floor((temp - mod) / 26)
  }
  return letter
}

const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  crcTable[i] = c >>> 0
}

function crc32(uint8) {
  let crc = 0xffffffff
  for (let i = 0; i < uint8.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ uint8[i]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(files) {
  const enc = new TextEncoder()
  const localHeaders = []
  const centralHeaders = []
  let offset = 0

  for (const file of files) {
    const nameBytes = enc.encode(file.name)
    const dataBytes = file.data instanceof Uint8Array ? file.data : enc.encode(file.data)
    const crc = crc32(dataBytes)
    const size = dataBytes.length

    const lh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0, true)
    lv.setUint16(8, 0, true) // Store method (0 = uncompressed)
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    lh.set(nameBytes, 30)

    const ch = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    ch.set(nameBytes, 46)

    localHeaders.push(lh, dataBytes)
    centralHeaders.push(ch)
    offset += lh.length + dataBytes.length
  }

  const centralOffset = offset
  let centralSize = 0
  for (const ch of centralHeaders) centralSize += ch.length

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true)

  const totalLength = offset + centralSize + 22
  const result = new Uint8Array(totalLength)
  let pos = 0
  for (const piece of [...localHeaders, ...centralHeaders, eocd]) {
    result.set(piece, pos)
    pos += piece.length
  }
  return result
}

/**
 * Generate a native .xlsx Blob from headers and data rows.
 * @param {{ headers: string[], rows: (string|number|null|undefined)[][] }} options
 * @returns {Blob}
 */
export function generateXlsxBlob({ headers, rows }) {
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><name val="Calibri"/><sz val="11"/></font>
    <font><b/><name val="Calibri"/><sz val="11"/></font>
    <font><u/><color rgb="FF0000EE"/><name val="Calibri"/><sz val="11"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left/><right/><top/>
      <bottom style="thin"><color rgb="FFD0D5DD"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
  </cellXfs>
</styleSheet>`

  // Auto-fit column widths based on maximum cell string length
  const colWidths = headers.map((h) => Math.max(h.length, 10))
  for (const row of rows) {
    for (let c = 0; c < headers.length; c++) {
      const val = row[c] ?? ''
      const maxLineLen = String(val).split('\n').reduce((max, line) => Math.max(max, line.length), 0)
      if (maxLineLen > colWidths[c]) colWidths[c] = Math.min(maxLineLen, 70)
    }
  }

  const hyperlinks = []
  const rels = []
  let relId = 1

  let sheetDataXml = '<sheetData>'

  // Header row (row 1)
  sheetDataXml += '<row r="1" ht="24" customHeight="1">'
  for (let c = 0; c < headers.length; c++) {
    const ref = `${colToLetter(c)}1`
    sheetDataXml += `<c r="${ref}" s="1" t="inlineStr"><is><t>${xmlEscape(headers[c])}</t></is></c>`
  }
  sheetDataXml += '</row>'

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const rowIdx = r + 2
    const row = rows[r]
    sheetDataXml += `<row r="${rowIdx}">`
    for (let c = 0; c < headers.length; c++) {
      const ref = `${colToLetter(c)}${rowIdx}`
      const val = row[c]
      if (val == null || val === '') continue

      const isNum = typeof val === 'number'
      const strVal = String(val)
      const isUrl = /^https?:\/\//i.test(strVal)
      const isMultiline = strVal.includes('\n')

      if (isUrl) {
        const rId = `rIdH${relId++}`
        hyperlinks.push(`<hyperlink ref="${ref}" r:id="${rId}" display="${xmlEscape(strVal)}"/>`)
        rels.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(strVal)}" TargetMode="External"/>`)
        sheetDataXml += `<c r="${ref}" s="2" t="inlineStr"><is><t>${xmlEscape(strVal)}</t></is></c>`
      } else if (isNum) {
        sheetDataXml += `<c r="${ref}"><v>${val}</v></c>`
      } else if (isMultiline) {
        sheetDataXml += `<c r="${ref}" s="3" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(strVal)}</t></is></c>`
      } else {
        sheetDataXml += `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(strVal)}</t></is></c>`
      }
    }
    sheetDataXml += '</row>'
  }
  sheetDataXml += '</sheetData>'

  const colsXml = '<cols>' + colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(w + 3, 12)}" customWidth="1"/>`).join('') + '</cols>'
  const hyperlinksXml = hyperlinks.length > 0 ? `<hyperlinks>${hyperlinks.join('')}</hyperlinks>` : ''

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${colsXml}
  ${sheetDataXml}
  ${hyperlinksXml}
</worksheet>`

  const sheet1RelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('\n  ')}
</Relationships>`

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Grades" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`

  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: relsXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
  ]
  if (rels.length > 0) {
    files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: sheet1RelsXml })
  }

  const zipBytes = buildZip(files)
  return new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
