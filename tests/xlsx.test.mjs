import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateXlsxBlob } from '../frontend/src/lib/xlsx.js'

test('generateXlsxBlob produces a valid PK zip blob with spreadsheet contents', async () => {
  const headers = ['confirmed_email', 'github_login', 'repo_url', 'earned_points', 'feedback_breakdown']
  const rows = [
    [
      'alessandro.sanen@student.pxl.be',
      'AlessandroSanen',
      'https://github.com/PXL-Automation-II/2627-autii-pe1-AlessandroSanen',
      20,
      'GROUP integrity PASS\nGROUP min.app PASS\n43 OK, 0 FAIL',
    ],
    [
      'oktay.gel@student.pxl.be',
      'Oktay-G',
      'https://github.com/PXL-Automation-II/2627-autii-pe1-Oktay-G',
      20,
      'GROUP integrity PASS\nGROUP min.app PASS\n43 OK, 0 FAIL',
    ],
  ]

  const blob = generateXlsxBlob({ headers, rows })
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

  const arrayBuffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  assert.ok(bytes.length > 500, 'XLSX blob has expected size')

  // Check PK ZIP magic signature
  assert.equal(bytes[0], 0x50) // 'P'
  assert.equal(bytes[1], 0x4b) // 'K'
  assert.equal(bytes[2], 0x03)
  assert.equal(bytes[3], 0x04)
})
