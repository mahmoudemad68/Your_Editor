#!/bin/sh
# Test the actual deployed non-root worker bundle, offline and read-only.
set -eu
docker run --rm --network none --read-only --entrypoint node "$1" -e '
const {packagedPrompts,loadPromptDirectory,PromptError}=require("@editagent/agent-core");
const p=packagedPrompts().load("agent-context","1.0.0").render({request:"English العربية",creativity:"conservative"});
if(!p.provenance.templateHash || p.instructions.includes("English العربية"))process.exit(1);
let rejected=false;try{loadPromptDirectory("/missing-packaged-prompts")}catch(e){rejected=e instanceof PromptError&&e.code==="bundle_unavailable";}
if(!rejected)process.exit(1);
console.log(JSON.stringify({status:"PASS",promptId:p.provenance.promptId,promptVersion:p.provenance.promptVersion,templateHash:p.provenance.templateHash,missingBundleRejected:true}));
'
