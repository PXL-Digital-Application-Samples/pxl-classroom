#!/usr/bin/env node
// PXL Classroom - generate the hub's claim keypair.
//
// Run once by a hub admin. The two halves go to deliberately different places:
//
//   PRIVATE -> the hub ENVIRONMENT secret PXL_CLAIM_PRIVATE_KEY, on the
//              `provisioning` environment, whose deployment branch policy is
//              `main` only. A job that does not name that environment cannot
//              read it at all, and there is no repository-level copy. This is
//              the key that decrypts every student's institutional email
//              address out of the public event archive, so it is the most
//              sensitive value in the system after the App key.
//
//   PUBLIC  -> committed to acceptance/claim-keys.json. A public key on a
//              public repository is exactly where a public key belongs: the
//              student's browser needs it to seal an address, and holding it
//              lets anyone encrypt, which is the point, and decrypt nothing.
//
// The private half is printed ONCE, here, and never written to a file - so it
// does not end up in the working tree, in a shell history that survives, or in
// a terminal transcript somebody later pastes. Copy it straight into the secret.
//
// Usage: node scripts/generate-claim-keypair.mjs [kid]
// See INSTALL.md §1.3.2.

import { generateClaimKeypair, CLAIM_PUBLIC_KEY_LENGTH } from "../lib/claim.mjs";

const kid = process.argv[2] || "1";
if (!/^[1-9][0-9]{0,2}$/.test(kid) || Number(kid) > 255) {
  console.error(`kid must be an integer 1..255, got "${kid}"`);
  process.exit(1);
}

const { privateKey, publicKey } = await generateClaimKeypair();

if (publicKey.length !== CLAIM_PUBLIC_KEY_LENGTH) {
  console.error(`generated public key is ${publicKey.length} chars, expected ${CLAIM_PUBLIC_KEY_LENGTH}`);
  process.exit(1);
}

console.log(`
Claim key id ${kid}.

1. Set the PRIVATE half as an ENVIRONMENT secret on the hub:

     Settings -> Environments -> provisioning -> Add secret
     Name:  PXL_CLAIM_PRIVATE_KEY

   NOT a repository secret. The provisioning environment allows the main branch
   only, so a workflow_dispatch at another ref cannot reach it, and a job that
   forgets to declare the environment cannot read it either.

${privateKey}

2. Add the PUBLIC half to acceptance/claim-keys.json and commit it:

     "current": "${kid}",
     "keys": { "${kid}": "${publicKey}" }

3. If this is a ROTATION, keep the previous key in the file. Claims already
   recorded are unaffected - they are plaintext in the control repo and were
   decrypted long ago - but a student whose browser cached the old public key
   would otherwise seal a claim the hub can no longer open. Point "current" at
   the new kid so fresh claims use it, and remove the old entry once no
   assignment is still accepting.

The private half is not saved anywhere. If you lose it before setting the
secret, run this again - nothing has been committed yet.
`);
