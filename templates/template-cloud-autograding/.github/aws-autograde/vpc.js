// One check, against the student's own AWS account.
//
// The io-grader compares this program's stdout to `expected-output` exactly, so
// there are only two useful things to print: the word the grader is waiting for
// when the account is right, and a sentence saying what is wrong when it is
// not. The wrong-answer text is what the student reads in their run log, so it
// says what was found rather than "test failed".
//
// Credentials come from ~/.aws/credentials, written by the workflow from the
// student's committed creds.txt. Nothing here reads a secret of the school's.

import { EC2Client, DescribeVpcsCommand } from "@aws-sdk/client-ec2";

const EXPECTED_CIDR = "10.0.0.0/16";

const ec2 = new EC2Client({});

function fail(message) {
  // Not stderr: the grader compares stdout, and a student staring at an empty
  // "expected correct, got nothing" learns less than a sentence.
  console.log(message);
  process.exit(0);
}

let vpcs;
try {
  const res = await ec2.send(new DescribeVpcsCommand({}));
  vpcs = res.Vpcs ?? [];
} catch (err) {
  // An expired lab session lands here, and it is the single most common reason
  // a check fails for a student who did the work.
  fail(`could not read your AWS account (${err.name}) - are your credentials in creds.txt still valid?`);
}

const built = vpcs.filter((v) => !v.IsDefault);

if (built.length === 0) fail("no VPC of your own was found - only the default VPC exists in this account");
if (built.length > 1) fail(`found ${built.length} non-default VPCs - the exercise asks for exactly one`);

const [vpc] = built;
if (vpc.CidrBlock !== EXPECTED_CIDR) fail(`the VPC has CIDR ${vpc.CidrBlock}, and the exercise asks for ${EXPECTED_CIDR}`);

console.log("correct");
