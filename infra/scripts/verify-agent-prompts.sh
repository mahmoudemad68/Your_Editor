#!/bin/sh
# Test the actual deployed non-root worker bundle, offline and read-only.
set -eu
docker run --rm --network none --read-only --entrypoint node "$1" -e '
const {packagedPrompts,loadPromptDirectory,PromptTemplate,PromptError}=require("@editagent/agent-core");
const {readFileSync}=require("node:fs"),path=require("node:path"),{createHash}=require("node:crypto");
const raw=readFileSync(path.join(path.dirname(require.resolve("@editagent/agent-core")),"prompts/agent-context@1.0.0.prompt"));
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const p=packagedPrompts().load("agent-context","1.0.0").render({request:"English العربية",creativity:"conservative"});
if(p.provenance.templateHash!==hash(raw) || p.instructions.includes("English العربية"))process.exit(1);
let rejected=false;try{loadPromptDirectory("/missing-packaged-prompts")}catch(e){rejected=e instanceof PromptError&&e.code==="bundle_unavailable";}
if(!rejected)process.exit(1);
let malformed=false;try{new PromptTemplate(Buffer.concat([raw,Buffer.from([0xc3,0x28,0xff,0xfe])]))}catch(e){malformed=e instanceof PromptError&&e.code==="invalid_template";}
if(!malformed)process.exit(1);
for(const lone of ["\ud800","\udc00"]){let invalid=false;try{new PromptTemplate(raw.toString("utf8")+lone)}catch(e){invalid=e instanceof PromptError&&e.code==="invalid_template";}if(!invalid)process.exit(1);}
const bilingual=Buffer.concat([raw,Buffer.from("\nEnglish العربية 😀\n")]);
if(new PromptTemplate(bilingual).templateHash!==hash(bilingual))process.exit(1);
console.log(JSON.stringify({status:"PASS",promptId:p.provenance.promptId,promptVersion:p.provenance.promptVersion,templateHash:p.provenance.templateHash,missingBundleRejected:true,rawByteHashVerified:true,malformedUtf8Rejected:true,loneSurrogatesRejected:true,bilingualByteHashVerified:true}));
'
