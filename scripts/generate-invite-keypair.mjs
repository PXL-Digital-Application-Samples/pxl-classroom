#!/usr/bin/env node
// PXL Classroom - generate an invitation signing keypair.
//
// Run once by a hub admin. The private half becomes the PXL_INVITE_SIGNING_KEY
// hub secret; the public half is committed to acceptance/invite-keys.json and
// read by every broker from a hub checkout. A public key on a public repository
// is exactly where a public key belongs - it is what lets the broker reject a
// forged token without holding anything worth stealing.
//
// Usage: node scripts/generate-invite-keypair.mjs [kid]
// See RUNBOOK §1.3.

import { generateKeyPair } from "../lib/invite-token.mjs";

const kid = process.argv[2] || "1";
if (!/^[1-9][0-9]{0,2}$/.test(kid) || Number(kid) > 255) {
  console.error(`kid must be an integer 1..255, got "${kid}"`);
  process.exit(1);
}

const { privateKeyPem, publicKeyBase64 } = generateKeyPair();

console.log(`
Key id ${kid}.

1. Set the PRIVATE half as the hub repository secret PXL_INVITE_SIGNING_KEY
   (Settings -> Secrets and variables -> Actions). It never leaves the hub.

${privateKeyPem}
2. Add the PUBLIC half to acceptance/invite-keys.json and commit it:

   "${kid}": "${publicKeyBase64}"

3. If this is a rotation, keep the previous key in the file so links already in
   circulation keep verifying, and set INVITE_KID to ${kid} so new links use
   this one. Remove the old entry once every assignment signed with it is closed.
`);
